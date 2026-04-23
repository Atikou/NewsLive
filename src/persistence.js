import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getLocalDateKey, oldestKeptDateKey } from "./zoned-time.js";

const DATA_DIR = path.resolve(process.cwd(), "data");
const NOTIFY_HISTORY_FILE = path.resolve(DATA_DIR, "notified-history.json");
const NEWS_DAYS_FILE = path.resolve(DATA_DIR, "news-days.json");
const NEWS_ARCHIVE_FILE = path.resolve(DATA_DIR, "news-archive.json");

export async function loadNotifyHistory() {
  try {
    const content = await readFile(NOTIFY_HISTORY_FILE, "utf-8");
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || typeof parsed.items !== "object") {
      return { items: {} };
    }
    return { items: parsed.items };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { items: {} };
    }
    throw error;
  }
}

export async function saveNotifyHistory(history) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(
    NOTIFY_HISTORY_FILE,
    JSON.stringify(
      {
        items: history.items || {}
      },
      null,
      2
    ),
    "utf-8"
  );
}

export function cleanupNotifyHistory(history, ttlMs, nowMs = Date.now()) {
  if (!history || !history.items || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    return { removed: 0 };
  }

  let removed = 0;
  for (const [itemId, previousIso] of Object.entries(history.items)) {
    const previousMs = new Date(previousIso).getTime();
    if (!Number.isFinite(previousMs)) {
      // Keep unknown values to avoid breaking dedupe.
      continue;
    }
    if (nowMs - previousMs > ttlMs) {
      delete history.items[itemId];
      removed += 1;
    }
  }

  return { removed };
}

export function getNotifyHistoryPath() {
  return NOTIFY_HISTORY_FILE;
}

export async function loadNewsDays() {
  try {
    const content = await readFile(NEWS_DAYS_FILE, "utf-8");
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object") {
      return { days: {} };
    }
    const days = parsed.days && typeof parsed.days === "object" ? parsed.days : {};
    return { days };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { days: {} };
    }
    throw error;
  }
}

export async function saveNewsDays(days) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(
    NEWS_DAYS_FILE,
    JSON.stringify(
      {
        days: days && typeof days === "object" ? days : {}
      },
      null,
      2
    ),
    "utf-8"
  );
}

export function cleanupNewsDays(days, cleanupIntervalDays, now = new Date(), timeZone = "") {
  if (!days || typeof days !== "object") {
    return { days: {}, removedItems: [] };
  }
  const keepDays = Math.max(1, Number(cleanupIntervalDays) || 1);
  const todayKey = getLocalDateKey(now, timeZone);
  const oldestKeep = oldestKeptDateKey(todayKey, keepDays);

  const cleanedDays = {};
  const removedItems = [];
  for (const [dateKey, items] of Object.entries(days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || dateKey < oldestKeep) {
      if (Array.isArray(items)) {
        removedItems.push(...items);
      }
      continue;
    }
    cleanedDays[dateKey] = Array.isArray(items) ? items : [];
  }
  return { days: cleanedDays, removedItems };
}

export async function loadNewsArchive() {
  try {
    const content = await readFile(NEWS_ARCHIVE_FILE, "utf-8");
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object") {
      return { items: [] };
    }
    return { items: Array.isArray(parsed.items) ? parsed.items : [] };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { items: [] };
    }
    throw error;
  }
}

export async function saveNewsArchive(items) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(
    NEWS_ARCHIVE_FILE,
    JSON.stringify(
      {
        items: Array.isArray(items) ? items : []
      },
      null,
      2
    ),
    "utf-8"
  );
}

export async function appendNewsArchive(itemsToAppend) {
  if (!Array.isArray(itemsToAppend) || !itemsToAppend.length) {
    return { added: 0, total: (await loadNewsArchive()).items.length };
  }
  const loaded = await loadNewsArchive();
  const existingKeys = new Set(
    loaded.items.map((item) => `${item.title || ""}|${item.url || ""}|${item.publishedAt || ""}`)
  );
  let added = 0;
  for (const item of itemsToAppend) {
    const key = `${item.title || ""}|${item.url || ""}|${item.publishedAt || ""}`;
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);
    loaded.items.push(item);
    added += 1;
  }
  await saveNewsArchive(loaded.items);
  return { added, total: loaded.items.length };
}

export async function clearNewsArchive() {
  await saveNewsArchive([]);
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 按「归档时间优先，否则发布时间」删除早于 retentionDays 天的归档条目。
 * @param {number} retentionDays 正整数为保留最近多少天；<=0 的调用方应跳过本函数
 */
export function pruneNewsArchiveItems(items, retentionDays, now = new Date()) {
  if (!Array.isArray(items) || !Number.isFinite(retentionDays) || retentionDays <= 0) {
    return { items: Array.isArray(items) ? items : [], removed: 0 };
  }
  const cutoffMs = now.getTime() - retentionDays * MS_PER_DAY;
  const kept = [];
  let removed = 0;
  for (const item of items) {
    const raw = (item && (item.archivedAt || item.publishedAt)) || "";
    const t = new Date(String(raw).trim()).getTime();
    if (!Number.isFinite(t)) {
      kept.push(item);
      continue;
    }
    if (t < cutoffMs) {
      removed += 1;
    } else {
      kept.push(item);
    }
  }
  return { items: kept, removed };
}

export function getNewsDaysPath() {
  return NEWS_DAYS_FILE;
}

export function getNewsArchivePath() {
  return NEWS_ARCHIVE_FILE;
}
