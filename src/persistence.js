import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { getLocalDateKey, oldestKeptDateKey } from "./zoned-time.js";

const DATA_DIR = path.resolve(process.cwd(), "data");
const NEWS_DAYS_FILE = path.resolve(DATA_DIR, "news-days.json");
const NEWS_ARCHIVE_FILE = path.resolve(DATA_DIR, "news-archive.json");

async function writeJsonAtomic(filePath, value) {
  await mkdir(DATA_DIR, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(value, null, 2), "utf-8");
    await rename(tempPath, filePath);
  } finally {
    await unlink(tempPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

function normalizeIsoDate(value) {
  const date = new Date(value || "");
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export async function loadNewsDays() {
  try {
    const content = await readFile(NEWS_DAYS_FILE, "utf-8");
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object") {
      return { days: {}, lastFetchAt: null };
    }
    const days = parsed.days && typeof parsed.days === "object" ? parsed.days : {};
    return { days, lastFetchAt: normalizeIsoDate(parsed.lastFetchAt) };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { days: {}, lastFetchAt: null };
    }
    throw error;
  }
}

export async function saveNewsDays(days, metadata = {}) {
  const lastFetchAt = normalizeIsoDate(metadata.lastFetchAt);
  await writeJsonAtomic(
    NEWS_DAYS_FILE,
    {
      days: days && typeof days === "object" ? days : {},
      ...(lastFetchAt ? { lastFetchAt } : {})
    }
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
  await writeJsonAtomic(
    NEWS_ARCHIVE_FILE,
    {
      items: Array.isArray(items) ? items : []
    }
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
