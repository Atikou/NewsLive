import crypto from "node:crypto";
import { crawlAllSources } from "./sources.js";
import { loadKeywords, loadSettings, loadSources } from "./config.js";
import { cleanupNotifyHistory, loadNotifyHistory, saveNotifyHistory } from "./persistence.js";
import { translateItemsWithAnthropic } from "./ai-translate.js";

function hashItem(item) {
  return crypto.createHash("sha1").update(`${item.title}|${item.url}`).digest("hex");
}

function matchKeywords(text, keywords) {
  const raw = String(text || "");
  const lower = raw.toLowerCase();
  return keywords.filter((word) => {
    const normalized = String(word || "").trim();
    if (!normalized) return false;
    // For pure Latin keywords (e.g. "AI"), match as a whole token to avoid
    // false positives like "detail" or "said".
    if (/^[A-Za-z0-9_-]+$/.test(normalized)) {
      const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const tokenRegex = new RegExp(`(^|[^A-Za-z0-9_-])${escaped}([^A-Za-z0-9_-]|$)`, "i");
      return tokenRegex.test(raw);
    }
    return lower.includes(normalized.toLowerCase());
  });
}

function getDisplayTitle(item) {
  return (item.titleZh || item.title || "").trim();
}

function parsePublishedDate(item) {
  const value = item?.pubDate;
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }
  return date;
}

function isSameLocalDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function escapeMarkdownText(text) {
  // ntfy/day.app body uses best-effort markdown/plaintext; escape brackets to avoid broken links.
  return String(text)
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)");
}

function escapeMarkdownUrl(url) {
  // Protect markdown link syntax when url contains parentheses.
  return String(url)
    .replaceAll(" ", "%20")
    .replaceAll("(", "%28")
    .replaceAll(")", "%29");
}

function formatItemTime(item) {
  const raw = item.pubDate || item.fetchedAt || "";
  if (!raw) return "";
  const s = String(raw).trim();
  // Prefer a short, readable form for ISO-like timestamps.
  // Examples: 2026-04-16T12:34:56.000Z -> 2026-04-16 12:34
  if (s.includes("T") && s.length >= 16) {
    return s.replace("T", " ").slice(0, 16);
  }
  return s;
}

function normalizeSourceName(value) {
  return String(value || "").trim().toLowerCase();
}

function getUtf8Length(text) {
  return Buffer.byteLength(String(text || ""), "utf8");
}

function buildPushLine(item, index) {
  const source = item.source ? `[${item.source}]` : "[来源]";
  const time = formatItemTime(item);
  const rawTitle = item.titleZh || item.title || "";
  const title = escapeMarkdownText(rawTitle);
  const url = item.url || "";
  const safeUrl = url ? escapeMarkdownUrl(url) : "";
  const titleLink = safeUrl ? `[${title}](${safeUrl})` : title;
  return `${index}. ${source} ${titleLink} - ${time}`;
}

function truncateLineToUtf8(line, maxBytes) {
  let text = String(line || "");
  if (getUtf8Length(text) <= maxBytes) {
    return text;
  }
  while (text.length > 1 && getUtf8Length(`${text}...`) > maxBytes) {
    text = text.slice(0, -1);
  }
  return `${text}...`;
}

function buildTagMessage(tag, items, maxItemsPerPush, maxMessageChars) {
  const limited = items.slice(0, maxItemsPerPush);
  const maxBytes = Math.max(512, Number(maxMessageChars) || 4096);
  const lines = [tag];
  const usedItems = [];
  for (const item of limited) {
    const nextLine = buildPushLine(item, usedItems.length + 1);
    const candidate = [...lines, nextLine].join("\n");
    if (getUtf8Length(candidate) <= maxBytes) {
      lines.push(nextLine);
      usedItems.push(item);
      continue;
    }
    if (!usedItems.length) {
      const headerBytes = getUtf8Length(`${tag}\n`);
      const availableBytes = Math.max(32, maxBytes - headerBytes);
      const trimmed = truncateLineToUtf8(nextLine, availableBytes);
      lines.push(trimmed);
      usedItems.push(item);
    }
    break;
  }
  return {
    message: lines.join("\n"),
    usedItems
  };
}

function splitByMessageLength(tag, items, maxItemsPerPush, maxMessageChars) {
  const chunks = [];
  let cursor = 0;
  while (cursor < items.length) {
    const { usedItems } = buildTagMessage(
      tag,
      items.slice(cursor),
      maxItemsPerPush,
      maxMessageChars
    );
    if (!usedItems.length) {
      break;
    }
    chunks.push(usedItems);
    cursor += usedItems.length;
  }
  return chunks;
}

function buildDayAppFullUrl(pushUrl, title, body) {
  if (pushUrl.includes("{title}") || pushUrl.includes("{body}")) {
    return pushUrl
      .replaceAll("{title}", encodeURIComponent(title))
      .replaceAll("{body}", encodeURIComponent(body));
  }
  const separator = pushUrl.includes("?") ? "&" : "?";
  return `${pushUrl}${separator}title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

function fitDayAppUrl(pushUrl, title, body, maxLength) {
  let safeBody = String(body || "");
  let fullUrl = buildDayAppFullUrl(pushUrl, title, safeBody);
  if (fullUrl.length <= maxLength) {
    return { fullUrl, body: safeBody };
  }

  // If a single message is too long, progressively trim it to fit day.app URL constraints.
  while (safeBody.length > 12) {
    safeBody = `${safeBody.slice(0, Math.floor(safeBody.length * 0.85)).trimEnd()}...`;
    fullUrl = buildDayAppFullUrl(pushUrl, title, safeBody);
    if (fullUrl.length <= maxLength) {
      return { fullUrl, body: safeBody };
    }
  }
  return null;
}

function getMinutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function isMinuteInRange(currentMinutes, startMinutes, endMinutes) {
  if (startMinutes < endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

function buildRangeEndDate(now, startMinutes, endMinutes) {
  const endDate = new Date(now);
  endDate.setSeconds(0, 0);
  endDate.setHours(Math.floor(endMinutes / 60), endMinutes % 60, 0, 0);
  const currentMinutes = getMinutesOfDay(now);
  const isCrossDay = startMinutes > endMinutes;
  if ((isCrossDay && currentMinutes >= startMinutes) || endDate.getTime() <= now.getTime()) {
    endDate.setDate(endDate.getDate() + 1);
  }
  return endDate;
}

function getMatchedPauseRange(now, ranges) {
  const currentMinutes = getMinutesOfDay(now);
  for (const range of ranges || []) {
    if (isMinuteInRange(currentMinutes, range.startMinutes, range.endMinutes)) {
      return {
        ...range,
        endAt: buildRangeEndDate(now, range.startMinutes, range.endMinutes)
      };
    }
  }
  return null;
}

async function pushToDayAppUrl(pushUrl, tag, items, maxItemsPerPush, maxMessageChars) {
  if (!pushUrl || !tag || !items.length) {
    return { ok: false, errorMessage: "" };
  }

  // day.app uses GET query params; many gateways reject large URLs with 431.
  const MAX_FULL_URL_LENGTH = 3_800;
  const maxLines = Math.min(items.length, maxItemsPerPush);

  for (let n = maxLines; n >= 1; n -= 1) {
    const limitedCount = n;
    const title = `NewsLive 重点内容 ${tag} ${limitedCount} 条`;
    const { message: body } = buildTagMessage(tag, items, n, maxMessageChars);
    const fitted = fitDayAppUrl(pushUrl, title, body, MAX_FULL_URL_LENGTH);
    if (fitted) {
      try {
        const res = await fetch(fitted.fullUrl, { method: "GET" });
        if (!res.ok) {
          return { ok: false, errorMessage: `day.app push failed (${res.status})` };
        }
        return { ok: true, errorMessage: "" };
      } catch (e) {
        return { ok: false, errorMessage: `day.app push error (${e.message || "unknown"})` };
      }
    }
  }

  return { ok: false, errorMessage: "day.app push skipped: payload too large for URL limit" };
}

async function pushToNtfyUrl(ntfyUrl, message) {
  if (!ntfyUrl || !message) {
    return { ok: false, errorMessage: "" };
  }

  try {
    const res = await fetch(ntfyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "text/markdown; charset=utf-8"
      },
      body: message
    });
    if (!res.ok) {
      return { ok: false, errorMessage: `ntfy push failed (${res.status})` };
    }
    return { ok: true, errorMessage: "" };
  } catch (e) {
    return { ok: false, errorMessage: `ntfy push error (${e.message || "unknown"})` };
  }
}

export class NewsCrawler {
  constructor() {
    this.history = { items: {} };
    this.state = {
      inProgress: false,
      crawlVersion: 0,
      items: [],
      keywords: [],
      priorityKeywords: [],
      errors: [],
      lastFetchAt: null,
      nextFetchAt: null,
      intervalMs: 30 * 60 * 1000,
      minIntervalMs: 2 * 60 * 1000,
      pushRepeatIntervalMs: 24 * 60 * 60 * 1000,
      uiPollIntervalMs: 15 * 1000,
      pushEnabled: true,
      settingsLoadedAt: null,
      pauseTimeRanges: [],
      pausedRange: null,
      pausedUntil: null,
      filteredOutByDateCount: 0,
      sourceHealth: [],
      sourceHealthSummary: {
        success: 0,
        failed: 0,
        other: 0
      }
    };
    this.lastAttemptAt = 0;
    this.initialized = false;
  }

  getState() {
    return { ...this.state };
  }

  async init() {
    if (this.initialized) {
      return;
    }
    this.history = await loadNotifyHistory();
    this.initialized = true;
  }

  getMsUntilNextAllowedFetch() {
    const now = Date.now();
    const elapsed = now - this.lastAttemptAt;
    return Math.max(0, this.state.minIntervalMs - elapsed);
  }

  canNotify(itemId, repeatIntervalMs, nowMs) {
    const previous = this.history.items[itemId];
    if (!previous) {
      return true;
    }
    const previousMs = new Date(previous).getTime();
    if (!Number.isFinite(previousMs)) {
      return true;
    }
    return nowMs - previousMs >= repeatIntervalMs;
  }

  async reloadSettings() {
    const settings = await loadSettings();
    this.state.intervalMs = settings.fetchIntervalMinutes * 60 * 1000;
    this.state.minIntervalMs = settings.minFetchIntervalMinutes * 60 * 1000;
    this.state.pushRepeatIntervalMs = settings.push.repeatIntervalMinutes * 60 * 1000;
    this.state.uiPollIntervalMs = settings.ui.pollIntervalSeconds * 1000;
    this.state.pushEnabled = settings.push.enabled;
    this.state.pauseTimeRanges = (settings.pauseTimeRanges || []).map((range) => range.text);
    this.state.settingsLoadedAt = new Date().toISOString();
    return settings;
  }

  async run(trigger = "scheduled") {
    await this.init();
    if (this.state.inProgress) {
      return { skipped: true, reason: "already_running" };
    }

    const settings = await this.reloadSettings();
    const now = new Date();
    const matchedPauseRange = getMatchedPauseRange(now, settings.pauseTimeRanges);
    if (matchedPauseRange) {
      this.state.pausedRange = matchedPauseRange.text;
      this.state.pausedUntil = matchedPauseRange.endAt.toISOString();
      this.state.nextFetchAt = this.state.pausedUntil;
      return {
        skipped: true,
        reason: "pause_time_range",
        range: matchedPauseRange.text,
        resumeAt: this.state.pausedUntil
      };
    }
    this.state.pausedRange = null;
    this.state.pausedUntil = null;

    const waitMs = this.getMsUntilNextAllowedFetch();
    if (waitMs > 0) {
      return { skipped: true, reason: "min_interval", waitMs };
    }

    this.state.inProgress = true;
    this.lastAttemptAt = Date.now();

    try {
      const [{ keywords, priorityKeywords }, sources] = await Promise.all([loadKeywords(), loadSources()]);

      const { items, errors, sourceResults } = await crawlAllSources({
        sources,
        requestTimeoutMs: settings.requestTimeoutSeconds * 1000
      });

      const enriched = items.map((item) => {
        const text = `${item.title}`;
        const matchedKeywords = matchKeywords(text, keywords);
        const matchedPriorityKeywords = matchKeywords(text, priorityKeywords);
        return {
          ...item,
          id: hashItem(item),
          matchedKeywords,
          matchedPriorityKeywords,
          isPriority: matchedPriorityKeywords.length > 0
        };
      });

      const nowLocal = new Date();
      let missingOrInvalidPubDateCount = 0;
      let nonTodayPubDateCount = 0;
      const dateFilteredItems = enriched.filter((item) => {
        const publishedDate = parsePublishedDate(item);
        if (!publishedDate) {
          missingOrInvalidPubDateCount += 1;
          return false;
        }
        if (!isSameLocalDay(publishedDate, nowLocal)) {
          nonTodayPubDateCount += 1;
          return false;
        }
        return true;
      });
      this.state.filteredOutByDateCount = missingOrInvalidPubDateCount + nonTodayPubDateCount;
      const translated = await translateItemsWithAnthropic(dateFilteredItems, settings.aiTranslation);
      const finalItems = translated.items.map((item) => {
        const text = `${item.title} ${item.titleZh || ""}`;
        const matchedKeywords = matchKeywords(text, keywords);
        const matchedPriorityKeywords = matchKeywords(text, priorityKeywords);
        return {
          ...item,
          matchedKeywords,
          matchedPriorityKeywords,
          isPriority: matchedPriorityKeywords.length > 0
        };
      });

      const nowMs = Date.now();
      const hasAnyPushUrl =
        Boolean(settings.push.dayAppPushUrl) || Boolean(settings.push.ntfyPushUrl);
      const pushSourceBlacklist = new Set(
        (settings.push.sourceBlacklist || []).map((value) => normalizeSourceName(value))
      );

      // Periodically prune old history to avoid unbounded growth.
      const { removed: removedHistoryCount } = cleanupNotifyHistory(
        this.history,
        settings.push.notifyHistoryTtlMinutes,
        nowMs
      );

      const priorityToNotify = finalItems.filter(
        (item) =>
          item.isPriority &&
          settings.push.enabled &&
          hasAnyPushUrl &&
          !pushSourceBlacklist.has(normalizeSourceName(item.source)) &&
          this.canNotify(item.id, this.state.pushRepeatIntervalMs, nowMs)
      );

      const tagToItems = new Map();
      for (const item of priorityToNotify) {
        for (const tag of item.matchedPriorityKeywords || []) {
          if (!tagToItems.has(tag)) {
            tagToItems.set(tag, []);
          }
          tagToItems.get(tag).push(item);
        }
      }

      const tasks = [];
      let didAnyPushSuccess = false;
      const pushErrorMessages = [];
      for (const tag of priorityKeywords) {
        const tagItems = tagToItems.get(tag) || [];
        if (!tagItems.length) continue;
        const tagChunks = splitByMessageLength(
          tag,
          tagItems,
          settings.push.maxItemsPerPush,
          settings.push.maxMessageChars
        );

        for (const chunkItems of tagChunks) {
          if (!chunkItems.length) continue;

          if (settings.push.dayAppPushUrl) {
            tasks.push(
              (async () => {
                const result = await pushToDayAppUrl(
                  settings.push.dayAppPushUrl,
                  tag,
                  chunkItems,
                  settings.push.maxItemsPerPush,
                  settings.push.maxMessageChars
                );
                return result;
              })()
            );
          }

          if (settings.push.ntfyPushUrl) {
            const { message } = buildTagMessage(
              tag,
              chunkItems,
              settings.push.maxItemsPerPush,
              settings.push.maxMessageChars
            );
            tasks.push(pushToNtfyUrl(settings.push.ntfyPushUrl, message));
          }
        }
      }

      const pushResults = await Promise.all(tasks);
      for (const r of pushResults) {
        if (r && r.ok) {
          didAnyPushSuccess = true;
        } else if (r && r.errorMessage) {
          pushErrorMessages.push(r.errorMessage);
        }
      }

      if (didAnyPushSuccess || removedHistoryCount > 0) {
        for (const item of priorityToNotify) {
          this.history.items[item.id] = new Date(nowMs).toISOString();
        }
        await saveNotifyHistory(this.history);
      }

      this.state.items = finalItems.sort((a, b) =>
        getDisplayTitle(a).localeCompare(getDisplayTitle(b), "zh-CN")
      );
      this.state.keywords = keywords;
      this.state.priorityKeywords = priorityKeywords;
      this.state.sourceHealth = Array.isArray(sourceResults) ? sourceResults : [];
      const summary = { success: 0, failed: 0, other: 0 };
      for (const item of this.state.sourceHealth) {
        if (item?.status === "success" || item?.status === "failed" || item?.status === "other") {
          summary[item.status] += 1;
        }
      }
      this.state.sourceHealthSummary = summary;
      this.state.errors = errors.slice();
      if (translated.errorMessage) {
        this.state.errors.push(translated.errorMessage);
      }
      if (this.state.filteredOutByDateCount > 0) {
        this.state.errors.push(
          `已过滤非当日新闻 ${this.state.filteredOutByDateCount} 条（无/非法发布时间 ${missingOrInvalidPubDateCount}，非当日 ${nonTodayPubDateCount}）`
        );
      }
      if (pushErrorMessages.length) {
        this.state.errors.push(...pushErrorMessages);
      }
      this.state.lastFetchAt = new Date().toISOString();
      this.state.nextFetchAt = new Date(Date.now() + this.state.intervalMs).toISOString();
      this.state.crawlVersion += 1;

      return {
        skipped: false,
        trigger,
        count: this.state.items.length,
        notified: didAnyPushSuccess ? priorityToNotify.length : 0,
        translated: translated.translatedCount
      };
    } catch (error) {
      this.state.errors = [error.message || "获取异常"];
      return {
        skipped: false,
        trigger,
        count: 0,
        error: error.message || "获取异常"
      };
    } finally {
      this.state.inProgress = false;
    }
  }
}
