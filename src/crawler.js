import crypto from "node:crypto";
import { translateItemsWithAi } from "./ai-translate.js";
import { loadSettings, loadSources, loadTopics } from "./config.js";
import {
  canonicalizeNewsUrl,
  clusterNewsItems,
  normalizeNewsTitle,
  repairNewsClusters
} from "./news-cluster.js";
import {
  appendNewsArchive,
  cleanupNewsDays,
  loadNewsArchive,
  loadNewsDays,
  pruneNewsArchiveItems,
  saveNewsArchive,
  saveNewsDays
} from "./persistence.js";
import { deliverQueuedPushes, getActivePushChannels } from "./push-service.js";
import {
  loadPushDeliveryLedger,
  loadPushQueue,
  mergePushQueue,
  pruneDeliveryLedger,
  savePushDeliveryLedger,
  savePushQueue
} from "./push-store.js";
import { crawlAllSources } from "./sources.js";
import { tagItemWithTopics } from "./topics.js";
import {
  createEmptyRankings,
  loadRankings,
  maybePushRankings,
  refreshRankings,
  saveRankings,
  summarizeRankings
} from "./rankings.js";
import {
  buildPauseRangeEndAt,
  getLocalDateKey,
  getMinutesOfDayInZone,
  isSameZonedCalendarDay
} from "./zoned-time.js";

function hashItem(item) {
  return crypto.createHash("sha1").update(`${item.title}|${item.url}`).digest("hex");
}

function getDisplayTitle(item) {
  return String(item?.titleZh || item?.title || "").trim();
}

function parsePublishedDate(item) {
  if (!item?.pubDate) return null;
  const date = new Date(item.pubDate);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function isPublishedAfter(item, cutoff) {
  const publishedDate = parsePublishedDate(item);
  const cutoffDate = cutoff instanceof Date ? cutoff : new Date(cutoff || "");
  return Boolean(
    publishedDate &&
      Number.isFinite(cutoffDate.getTime()) &&
      publishedDate.getTime() > cutoffDate.getTime()
  );
}

function normalizeSourceName(value) {
  return String(value || "").trim().toLowerCase();
}

function isMinuteInRange(currentMinutes, startMinutes, endMinutes) {
  if (startMinutes < endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

function getMatchedQuietRange(now, ranges, timeZone) {
  const currentMinutes = getMinutesOfDayInZone(now, timeZone);
  for (const range of ranges || []) {
    if (isMinuteInRange(currentMinutes, range.startMinutes, range.endMinutes)) {
      return {
        ...range,
        endAt: buildPauseRangeEndAt(now, range.startMinutes, range.endMinutes, timeZone)
      };
    }
  }
  return null;
}

function isFullyBlacklisted(item, blacklist) {
  if (!blacklist.size) return false;
  const sources = Array.from(
    new Set([item?.source, ...(item?.relatedSources || [])].map(normalizeSourceName).filter(Boolean))
  );
  return sources.length > 0 && sources.every((source) => blacklist.has(source));
}

function sortNewsItems(items) {
  return items.slice().sort((a, b) => {
    const dateDiff =
      new Date(b.pubDate || b.fetchedAt || 0) - new Date(a.pubDate || a.fetchedAt || 0);
    return Number.isFinite(dateDiff) && dateDiff !== 0
      ? dateDiff
      : getDisplayTitle(a).localeCompare(getDisplayTitle(b), "zh-CN");
  });
}

function reuseKnownTranslations(items, existingItems) {
  const byUrl = new Map();
  const byTitle = new Map();
  for (const item of existingItems || []) {
    const titleZh = String(item?.titleZh || "").trim();
    if (!titleZh) continue;
    const url = canonicalizeNewsUrl(item?.url);
    const title = normalizeNewsTitle(item?.title);
    if (url) byUrl.set(url, titleZh);
    if (title) byTitle.set(title, titleZh);
    for (const link of item?.relatedLinks || []) {
      const linkUrl = canonicalizeNewsUrl(link?.url);
      const linkTitle = normalizeNewsTitle(link?.title);
      if (linkUrl) byUrl.set(linkUrl, titleZh);
      if (linkTitle) byTitle.set(linkTitle, titleZh);
    }
  }
  return (items || []).map((item) => {
    if (String(item?.titleZh || "").trim()) return item;
    const known =
      byUrl.get(canonicalizeNewsUrl(item?.url)) ||
      byTitle.get(normalizeNewsTitle(item?.title));
    return known ? { ...item, titleZh: known } : item;
  });
}

export class NewsCrawler {
  constructor() {
    this.newsDays = {};
    this.newsArchiveCount = 0;
    this.pushQueue = { version: 1, items: [] };
    this.deliveryLedger = { version: 1, events: {} };
    this.rankings = createEmptyRankings();
    this.state = {
      inProgress: false,
      crawlVersion: 0,
      items: [],
      topics: [],
      errors: [],
      lastFetchAt: null,
      nextFetchAt: null,
      intervalMs: 30 * 60 * 1000,
      minIntervalMs: 2 * 60 * 1000,
      uiPollIntervalMs: 15 * 1000,
      pushEnabled: true,
      pushActiveChannels: [],
      pushQueueCount: 0,
      pushQuietTimeRanges: [],
      pushQuietRange: null,
      pushQuietUntil: null,
      lastPushDeliveryAt: null,
      settingsLoadedAt: null,
      filteredOutByDateCount: 0,
      sourceHealth: [],
      sourceHealthSummary: { success: 0, failed: 0, other: 0 },
      todayItemCount: 0,
      archiveItemCount: 0,
      rankingsGeneratedAt: null,
      rankingPlatforms: summarizeRankings(this.rankings),
      rankingErrors: [],
      lastRankingPushAt: null,
      timezone: ""
    };
    this.lastAttemptAt = 0;
    this.initialized = false;
  }

  getState() {
    return { ...this.state };
  }

  async init() {
    if (this.initialized) return;
    const [newsDays, archive, pushQueue, deliveryLedger, rankings] = await Promise.all([
      loadNewsDays(),
      loadNewsArchive(),
      loadPushQueue(),
      loadPushDeliveryLedger(),
      loadRankings()
    ]);
    this.newsDays = newsDays.days;
    this.state.lastFetchAt = newsDays.lastFetchAt || null;
    this.newsArchiveCount = archive.items.length;
    this.pushQueue = pushQueue;
    this.deliveryLedger = deliveryLedger;
    this.rankings = rankings;
    this.state.pushQueueCount = pushQueue.items.length;
    this.state.rankingsGeneratedAt = rankings.generatedAt;
    this.state.rankingPlatforms = summarizeRankings(rankings);
    this.initialized = true;
  }

  async hydrateCachedState() {
    await this.init();
    const settings = await this.reloadSettings();
    const topics = await loadTopics();
    const dateKey = getLocalDateKey(new Date(), settings.timezone);
    const cachedItems = clusterNewsItems(repairNewsClusters(this.newsDays[dateKey] || [])).map((item) =>
      tagItemWithTopics(item, topics)
    );
    this.state.items = sortNewsItems(cachedItems);
    this.state.todayItemCount = cachedItems.length;
    this.state.archiveItemCount = this.newsArchiveCount;
    this.state.pushQueueCount = this.pushQueue.items.length;
    this.state.topics = topics;
    this.state.rankingsGeneratedAt = this.rankings.generatedAt;
    this.state.rankingPlatforms = summarizeRankings(this.rankings);
    const quietRange = getMatchedQuietRange(
      new Date(),
      settings.push.quietTimeRanges,
      settings.timezone
    );
    this.state.pushQuietRange = quietRange?.text || null;
    this.state.pushQuietUntil = quietRange?.endAt?.toISOString() || null;
    return this.getState();
  }

  getMsUntilNextAllowedFetch() {
    return Math.max(0, this.state.minIntervalMs - (Date.now() - this.lastAttemptAt));
  }

  async reloadSettings() {
    const settings = await loadSettings();
    this.state.intervalMs = settings.fetchIntervalMinutes * 60 * 1000;
    this.state.minIntervalMs = settings.minFetchIntervalMinutes * 60 * 1000;
    this.state.uiPollIntervalMs = settings.ui.pollIntervalSeconds * 1000;
    this.state.pushEnabled = settings.push.enabled;
    this.state.pushActiveChannels = getActivePushChannels(settings);
    this.state.rankingsEnabled = settings.rankings.enabled;
    this.state.rankingPushTimes = settings.rankings.push.times;
    this.state.pushQuietTimeRanges = (settings.push.quietTimeRanges || []).map(
      (range) => range.text
    );
    this.state.newsCleanupIntervalDays = settings.newsRetention.cleanupIntervalDays;
    this.state.archiveOnCleanup = settings.newsRetention.archiveOnCleanup;
    this.state.archiveRetentionDays = settings.newsRetention.archiveRetentionDays;
    this.state.timezone =
      settings.timezone ||
      (() => {
        try {
          return Intl.DateTimeFormat().resolvedOptions().timeZone;
        } catch {
          return "UTC";
        }
      })();
    this.state.settingsLoadedAt = new Date().toISOString();
    return settings;
  }

  async run(trigger = "scheduled") {
    await this.init();
    if (this.state.inProgress) return { skipped: true, reason: "already_running" };

    const settings = await this.reloadSettings();
    const now = new Date();
    // 首轮启动只建立数据基线，不把当天更早发布的历史内容当作即时推送。
    // 后续轮次则以最近一次成功抓取时间为界，仅推送真正新增发布的事件。
    const previousFetchAt = new Date(this.state.lastFetchAt || "");
    const pushPublishedAfter = Number.isFinite(previousFetchAt.getTime())
      ? previousFetchAt
      : now;
    const quietRange = getMatchedQuietRange(
      now,
      settings.push.quietTimeRanges,
      settings.timezone
    );
    this.state.pushQuietRange = quietRange?.text || null;
    this.state.pushQuietUntil = quietRange?.endAt?.toISOString() || null;

    const waitMs = this.getMsUntilNextAllowedFetch();
    if (waitMs > 0) return { skipped: true, reason: "min_interval", waitMs };

    this.state.inProgress = true;
    this.lastAttemptAt = Date.now();

    try {
      const [topics, sources] = await Promise.all([
        loadTopics(),
        loadSources()
      ]);
      const { items, errors, sourceResults } = await crawlAllSources({
        sources,
        requestTimeoutMs: settings.requestTimeoutSeconds * 1000
      });

      const rankingErrors = [];
      try {
        this.rankings = await refreshRankings(
          this.rankings,
          {
            ...settings.rankings,
            requestTimeoutMs: settings.rankings.requestTimeoutSeconds * 1000
          },
          { now }
        );
        await saveRankings(this.rankings);
      } catch (error) {
        rankingErrors.push(error.message || "榜单更新失败");
      }

      const enriched = items.map((item) =>
        tagItemWithTopics({ ...item, id: hashItem(item) }, topics)
      );
      const nowLocal = new Date();
      const tz = settings.timezone;
      let missingOrInvalidPubDateCount = 0;
      let nonTodayPubDateCount = 0;
      const dateFilteredItems = enriched.filter((item) => {
        const publishedDate = parsePublishedDate(item);
        if (!publishedDate) {
          missingOrInvalidPubDateCount += 1;
          return false;
        }
        if (!isSameZonedCalendarDay(publishedDate, nowLocal, tz)) {
          nonTodayPubDateCount += 1;
          return false;
        }
        return true;
      });
      this.state.filteredOutByDateCount = missingOrInvalidPubDateCount + nonTodayPubDateCount;

      const dateKey = getLocalDateKey(nowLocal, tz);

      // 先统一旧数据事件模型，再利用已保存的翻译和事件进行预去重。
      // 这样同一 RSS 标题不会每轮重复调用付费翻译接口。
      for (const [key, dayItems] of Object.entries(this.newsDays)) {
        this.newsDays[key] = clusterNewsItems(repairNewsClusters(dayItems)).map((item) =>
          tagItemWithTopics(item, topics)
        );
      }
      const currentDayItems = Array.isArray(this.newsDays[dateKey]) ? this.newsDays[dateKey] : [];
      const fetchedEvents = clusterNewsItems(dateFilteredItems);
      const translationReadyItems = reuseKnownTranslations(fetchedEvents, currentDayItems);
      const translated = await translateItemsWithAi(
        translationReadyItems,
        settings.aiTranslation
      );
      const finalItems = translated.items.map((item) =>
        tagItemWithTopics(item, topics)
      );
      const existingEventIds = new Set(currentDayItems.map((item) => item.eventId).filter(Boolean));
      this.newsDays[dateKey] = clusterNewsItems([...currentDayItems, ...finalItems]).map((item) =>
        tagItemWithTopics(item, topics)
      );

      const { days: cleanedDays, removedItems } = cleanupNewsDays(
        this.newsDays,
        settings.newsRetention.cleanupIntervalDays,
        nowLocal,
        tz
      );
      this.newsDays = cleanedDays;
      const todayAllItems = Array.isArray(this.newsDays[dateKey]) ? this.newsDays[dateKey] : [];
      const todayNewEvents = todayAllItems.filter((item) => !existingEventIds.has(item.eventId));

      if (settings.newsRetention.archiveOnCleanup && removedItems.length > 0) {
        const archivedAt = new Date().toISOString();
        await appendNewsArchive(
          removedItems.map((item) => ({
            eventId: item.eventId || "",
            title: getDisplayTitle(item),
            url: item.url || "",
            tags: Array.from(
              new Set(item.matchedTopicNames || [])
            ),
            publishedAt: item.pubDate || item.fetchedAt || "",
            source: item.source || "",
            relatedSources: item.relatedSources || [],
            relatedLinks: item.relatedLinks || [],
            sourceCount: item.sourceCount || 1,
            clusterSize: item.clusterSize || 1,
            category: item.category || "",
            categories: item.categories || [],
            region: item.region || "",
            regions: item.regions || [],
            archivedAt
          }))
        );
      }

      let archiveItems = (await loadNewsArchive()).items;
      if (Number(settings.newsRetention.archiveRetentionDays) > 0) {
        const pruned = pruneNewsArchiveItems(
          archiveItems,
          settings.newsRetention.archiveRetentionDays,
          nowLocal
        );
        if (pruned.removed > 0) await saveNewsArchive(pruned.items);
        archiveItems = pruned.items;
      }
      this.newsArchiveCount = archiveItems.length;
      await saveNewsDays(this.newsDays, { lastFetchAt: now.toISOString() });

      const activeChannels = getActivePushChannels(settings);
      const blacklist = new Set(settings.push.sourceBlacklist.map(normalizeSourceName));
      const priorityToQueue = todayNewEvents.filter(
        (item) =>
          item.isPriority &&
          isPublishedAfter(item, pushPublishedAfter) &&
          settings.push.enabled &&
          activeChannels.length > 0 &&
          !isFullyBlacklisted(item, blacklist)
      );
      this.pushQueue = mergePushQueue(
        this.pushQueue,
        priorityToQueue.map((item) => ({ ...item, targetChannels: activeChannels })),
        now.toISOString()
      );
      this.deliveryLedger = pruneDeliveryLedger(
        this.deliveryLedger,
        settings.push.deliveryLedgerRetentionDays,
        now,
        this.pushQueue.items.map((item) => item.eventId)
      );
      await Promise.all([
        savePushQueue(this.pushQueue),
        savePushDeliveryLedger(this.deliveryLedger)
      ]);

      let pushErrors = [];
      let delivered = [];
      if (!quietRange && activeChannels.length > 0 && this.pushQueue.items.length > 0) {
        const delivery = await deliverQueuedPushes({
          queue: this.pushQueue,
          ledger: this.deliveryLedger,
          settings,
          now,
          onProgress: async ({ queue, ledger }) => {
            // 成功账本先落盘：即使进程随后退出，重启也不会重复投递已成功的渠道。
            await savePushDeliveryLedger(ledger);
            await savePushQueue(queue);
          }
        });
        this.pushQueue = delivery.queue;
        this.deliveryLedger = delivery.ledger;
        pushErrors = delivery.errors;
        delivered = delivery.delivered;
        if (delivered.length) this.state.lastPushDeliveryAt = now.toISOString();
      }

      if (!quietRange && settings.rankings.enabled && settings.rankings.push.enabled) {
        try {
          const rankingDelivery = await maybePushRankings(this.rankings, settings, { now });
          this.rankings = rankingDelivery.snapshot;
          await saveRankings(this.rankings);
          if (rankingDelivery.delivered.length) this.state.lastRankingPushAt = now.toISOString();
          if (rankingDelivery.errors.length) rankingErrors.push(...rankingDelivery.errors);
        } catch (error) {
          rankingErrors.push(error.message || "榜单推送失败");
        }
      }

      this.state.items = sortNewsItems(todayAllItems);
      this.state.todayItemCount = this.state.items.length;
      this.state.archiveItemCount = this.newsArchiveCount;
      this.state.pushQueueCount = this.pushQueue.items.length;
      this.state.topics = topics;
      this.state.rankingsGeneratedAt = this.rankings.generatedAt;
      this.state.rankingPlatforms = summarizeRankings(this.rankings);
      this.state.rankingErrors = [
        ...rankingErrors,
        ...this.state.rankingPlatforms.map((item) => item.errorMessage).filter(Boolean)
      ];
      this.state.sourceHealth = Array.isArray(sourceResults) ? sourceResults : [];
      const summary = { success: 0, failed: 0, other: 0 };
      for (const item of this.state.sourceHealth) {
        if (Object.hasOwn(summary, item?.status)) summary[item.status] += 1;
      }
      this.state.sourceHealthSummary = summary;
      this.state.errors = errors.slice();
      if (translated.errorMessage) this.state.errors.push(translated.errorMessage);
      if (pushErrors.length) {
        this.state.errors.push(...pushErrors);
        console.error("[NewsLive push]", pushErrors.join(" | "));
      }
      // 记录本轮开始时间，避免把抓取耗时形成的时间窗口遗漏到下一轮推送判断之外。
      this.state.lastFetchAt = now.toISOString();
      this.state.nextFetchAt = new Date(Date.now() + this.state.intervalMs).toISOString();
      this.state.crawlVersion += 1;

      return {
        skipped: false,
        trigger,
        count: this.state.items.length,
        newEvents: todayNewEvents.length,
        queued: priorityToQueue.length,
        notified: new Set(delivered.map((item) => item.eventId)).size,
        translated: translated.translatedCount,
        pushQuiet: Boolean(quietRange)
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
