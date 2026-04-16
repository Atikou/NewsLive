import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DATA_DIR = path.resolve(process.cwd(), "data");
const NOTIFY_HISTORY_FILE = path.resolve(DATA_DIR, "notified-history.json");

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
