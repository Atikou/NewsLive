import crypto from "node:crypto";
import { crawlAllSources } from "./sources.js";
import { loadKeywords, loadSettings, loadSources } from "./config.js";
import { loadNotifyHistory, saveNotifyHistory } from "./persistence.js";

function hashItem(item) {
  return crypto.createHash("sha1").update(`${item.title}|${item.url}`).digest("hex");
}

function matchKeywords(text, keywords) {
  const lower = text.toLowerCase();
  return keywords.filter((word) => lower.includes(word.toLowerCase()));
}

async function pushToDayAppUrl(pushUrl, items, maxItemsPerPush) {
  if (!pushUrl || !items.length) {
    return;
  }

  const title = `NewsLive 重点内容 ${items.length} 条`;
  const body = items
    .slice(0, maxItemsPerPush)
    .map((item, index) => `${index + 1}. ${item.title}`)
    .join("\n");
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
  await fetch(fullUrl, { method: "GET" });
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
      const priorityToNotify = enriched.filter(
        (item) =>
          item.isPriority &&
          settings.push.enabled &&
          settings.push.dayAppPushUrl &&
          this.canNotify(item.id, this.state.pushRepeatIntervalMs, nowMs)
      );
      await pushToDayAppUrl(
        settings.push.dayAppPushUrl,
        priorityToNotify,
        settings.push.maxItemsPerPush
      );
      for (const item of priorityToNotify) {
        this.history.items[item.id] = new Date(nowMs).toISOString();
      }
      await saveNotifyHistory(this.history);

      this.state.items = enriched.sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
      this.state.keywords = keywords;
      this.state.priorityKeywords = priorityKeywords;
      this.state.errors = errors;
      this.state.lastFetchAt = new Date().toISOString();
      this.state.nextFetchAt = new Date(Date.now() + this.state.intervalMs).toISOString();
      this.state.crawlVersion += 1;

      return {
        skipped: false,
        trigger,
        count: this.state.items.length,
        notified: priorityToNotify.length
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
