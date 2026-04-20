import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

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

export function cleanupNewsDays(days, cleanupIntervalDays, now = new Date()) {
  if (!days || typeof days !== "object") {
    return { days: {}, removedItems: [] };
  }
  const keepDays = Math.max(1, Number(cleanupIntervalDays) || 1);
  const cutoff = new Date(now);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (keepDays - 1));

  const cleanedDays = {};
  const removedItems = [];
  for (const [dateKey, items] of Object.entries(days)) {
    const dateObj = new Date(`${dateKey}T00:00:00`);
    if (!Number.isFinite(dateObj.getTime()) || dateObj < cutoff) {
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

export function getNewsDaysPath() {
  return NEWS_DAYS_FILE;
}

export function getNewsArchivePath() {
  return NEWS_ARCHIVE_FILE;
}
