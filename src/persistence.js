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

export function getNotifyHistoryPath() {
  return NOTIFY_HISTORY_FILE;
}
