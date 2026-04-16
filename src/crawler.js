import crypto from "node:crypto";
import { crawlAllSources } from "./sources.js";
import { loadKeywords, loadSettings, loadSources } from "./config.js";
import { cleanupNotifyHistory, loadNotifyHistory, saveNotifyHistory } from "./persistence.js";

function hashItem(item) {
  return crypto.createHash("sha1").update(`${item.title}|${item.url}`).digest("hex");
}

function matchKeywords(text, keywords) {
  const lower = text.toLowerCase();
  return keywords.filter((word) => lower.includes(word.toLowerCase()));
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

function splitIntoChunks(items, chunkSize) {
  if (!Array.isArray(items) || !items.length) return [];
  const size = Math.max(1, Number(chunkSize) || 1);
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function normalizeSourceName(value) {
  return String(value || "").trim().toLowerCase();
}

function buildTagMessage(tag, items, maxItemsPerPush) {
  const limited = items.slice(0, maxItemsPerPush);
  const newsLines = limited.map((item, index) => {
    const source = item.source ? `[${item.source}]` : "[来源]";
    const time = formatItemTime(item);
    const title = escapeMarkdownText(item.title || "");
    const url = item.url || "";
    const safeUrl = url ? escapeMarkdownUrl(url) : "";
    const titleLink = safeUrl ? `[${title}](${safeUrl})` : title;
    return `${index + 1}. ${source} ${titleLink} - ${time}`;
  });
  return [tag, ...newsLines].join("\n");
}

async function pushToDayAppUrl(pushUrl, tag, items, maxItemsPerPush) {
  if (!pushUrl || !tag || !items.length) {
    return { ok: false, errorMessage: "" };
  }

  // day.app uses GET with query parameters; overly long URLs may cause 431.
  const MAX_FULL_URL_LENGTH = 8_000;
  const maxLines = Math.min(items.length, maxItemsPerPush);

  let lastBody = "";
  let lastFullUrl = "";
  for (let n = maxLines; n >= 1; n -= 1) {
    const limitedCount = n;
    const title = `NewsLive 重点内容 ${tag} ${limitedCount} 条`;
    const body = buildTagMessage(tag, items, n);

    let fullUrl = pushUrl;
    if (pushUrl.includes("{title}") || pushUrl.includes("{body}")) {
      fullUrl = pushUrl
        .replaceAll("{title}", encodeURIComponent(title))
        .replaceAll("{body}", encodeURIComponent(body));
    } else {
      const separator = pushUrl.includes("?") ? "&" : "?";
      fullUrl = `${pushUrl}${separator}title=${encodeURIComponent(title)}&body=${encodeURIComponent(
        body
      )}`;
    }

    lastBody = body;
    lastFullUrl = fullUrl;
    if (fullUrl.length <= MAX_FULL_URL_LENGTH) {
      const res = await fetch(fullUrl, { method: "GET" });
      if (!res.ok) {
        return { ok: false, errorMessage: `day.app push failed (${res.status})` };
      }
      return { ok: true, errorMessage: "" };
    }
  }

  // If nothing matches the limit, still try the smallest payload (n=1).
  try {
    const title = `NewsLive 重点内容 ${tag} 1 条`;
    const body = buildTagMessage(tag, items, 1);
    const fullUrl = pushUrl.includes("{title}") || pushUrl.includes("{body}")
      ? pushUrl
          .replaceAll("{title}", encodeURIComponent(title))
          .replaceAll("{body}", encodeURIComponent(body))
      : `${pushUrl}${pushUrl.includes("?") ? "&" : "?"}title=${encodeURIComponent(title)}&body=${encodeURIComponent(
          body
        )}`;
    const res = await fetch(fullUrl, { method: "GET" });
    if (!res.ok) {
      return { ok: false, errorMessage: `day.app push failed (${res.status})` };
    }
    // Keep variables referenced to avoid linter complaining about unused.
    // eslint-disable-next-line no-unused-vars
    lastBody;
    // eslint-disable-next-line no-unused-vars
    lastFullUrl;
    return { ok: true, errorMessage: "" };
  } catch (e) {
    return { ok: false, errorMessage: `day.app push error (${e.message || "unknown"})` };
  }
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
      settingsLoadedAt: null
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
    this.state.settingsLoadedAt = new Date().toISOString();
    return settings;
  }

  async run(trigger = "scheduled") {
    await this.init();
    if (this.state.inProgress) {
      return { skipped: true, reason: "already_running" };
    }

    const waitMs = this.getMsUntilNextAllowedFetch();
    if (waitMs > 0) {
      return { skipped: true, reason: "min_interval", waitMs };
    }

    this.state.inProgress = true;
    this.lastAttemptAt = Date.now();

    try {
      const [settings, { keywords, priorityKeywords }, sources] = await Promise.all([
        this.reloadSettings(),
        loadKeywords(),
        loadSources()
      ]);

      const { items, errors } = await crawlAllSources({
        sources,
        requestTimeoutMs: settings.requestTimeoutSeconds * 1000
      });

      const enriched = items.map((item) => {
        const text = `${item.title} ${item.url}`;
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

      const priorityToNotify = enriched.filter(
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
        const tagChunks = splitIntoChunks(tagItems, 10);

        for (const chunkItems of tagChunks) {
          if (!chunkItems.length) continue;

          if (settings.push.dayAppPushUrl) {
            tasks.push(
              (async () => {
                const result = await pushToDayAppUrl(
                  settings.push.dayAppPushUrl,
                  tag,
                  chunkItems,
                  settings.push.maxItemsPerPush
                );
                return result;
              })()
            );
          }

          if (settings.push.ntfyPushUrl) {
            const message = buildTagMessage(tag, chunkItems, settings.push.maxItemsPerPush);
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

      this.state.items = enriched.sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
      this.state.keywords = keywords;
      this.state.priorityKeywords = priorityKeywords;
      this.state.errors = pushErrorMessages.length ? errors.concat(pushErrorMessages) : errors;
      this.state.lastFetchAt = new Date().toISOString();
      this.state.nextFetchAt = new Date(Date.now() + this.state.intervalMs).toISOString();
      this.state.crawlVersion += 1;

      return {
        skipped: false,
        trigger,
        count: this.state.items.length,
        notified: didAnyPushSuccess ? priorityToNotify.length : 0
      };
    } catch (error) {
      this.state.errors = [error.message || "抓取异常"];
      return {
        skipped: false,
        trigger,
        count: 0,
        error: error.message || "抓取异常"
      };
    } finally {
      this.state.inProgress = false;
    }
  }
}
