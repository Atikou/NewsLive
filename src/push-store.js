import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const DATA_DIR = path.resolve(process.cwd(), "data");
const PUSH_QUEUE_FILE = path.resolve(DATA_DIR, "push-queue.json");
const PUSH_DELIVERY_FILE = path.resolve(DATA_DIR, "push-delivery.json");

function uniqueStrings(values) {
  return Array.from(
    new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))
  );
}

function eventKey(item) {
  return String(item?.eventId || item?.id || "").trim();
}

function createEmptyQueue() {
  return { version: 1, items: [] };
}

function createEmptyLedger() {
  return { version: 1, events: {} };
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf-8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(filePath, value) {
  await mkdir(DATA_DIR, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempPath, JSON.stringify(value, null, 2), "utf-8");
  await rename(tempPath, filePath);
}

export function toPushSnapshot(item, queuedAt = new Date().toISOString()) {
  const eventId = eventKey(item);
  if (!eventId) return null;
  return {
    eventId,
    id: String(item?.id || eventId),
    title: String(item?.title || ""),
    titleZh: String(item?.titleZh || ""),
    url: String(item?.url || ""),
    source: String(item?.source || ""),
    pubDate: String(item?.pubDate || ""),
    fetchedAt: String(item?.fetchedAt || ""),
    relatedSources: uniqueStrings([item?.source, ...(item?.relatedSources || [])]),
    relatedLinks: Array.isArray(item?.relatedLinks) ? item.relatedLinks : [],
    matchedKeywords: uniqueStrings(item?.matchedKeywords),
    matchedTopics: uniqueStrings(item?.matchedTopics),
    matchedTopicNames: uniqueStrings(item?.matchedTopicNames),
    matchedPushTopics: uniqueStrings(item?.matchedPushTopics),
    targetChannels: uniqueStrings(item?.targetChannels),
    queuedAt: String(item?.queuedAt || queuedAt)
  };
}

function mergeSnapshot(previous, next) {
  return {
    ...previous,
    ...next,
    title: next.title || previous.title || "",
    titleZh: next.titleZh || previous.titleZh || "",
    url: next.url || previous.url || "",
    source: next.source || previous.source || "",
    pubDate: next.pubDate || previous.pubDate || "",
    fetchedAt: next.fetchedAt || previous.fetchedAt || "",
    relatedSources: uniqueStrings([
      ...(previous.relatedSources || []),
      ...(next.relatedSources || [])
    ]),
    relatedLinks: Array.from(
      new Map(
        [...(previous.relatedLinks || []), ...(next.relatedLinks || [])]
          .filter((link) => link?.url)
          .map((link) => [String(link.url), link])
      ).values()
    ),
    matchedKeywords: uniqueStrings([
      ...(previous.matchedKeywords || []),
      ...(next.matchedKeywords || [])
    ]),
    matchedTopics: uniqueStrings([
      ...(previous.matchedTopics || []),
      ...(next.matchedTopics || [])
    ]),
    matchedTopicNames: uniqueStrings([
      ...(previous.matchedTopicNames || []),
      ...(next.matchedTopicNames || [])
    ]),
    matchedPushTopics: uniqueStrings([
      ...(previous.matchedPushTopics || []),
      ...(next.matchedPushTopics || [])
    ]),
    targetChannels: uniqueStrings([
      ...(previous.targetChannels || []),
      ...(next.targetChannels || [])
    ]),
    queuedAt: previous.queuedAt || next.queuedAt
  };
}

export function mergePushQueue(queue, items, queuedAt = new Date().toISOString()) {
  const byId = new Map();
  for (const raw of Array.isArray(queue?.items) ? queue.items : []) {
    const snapshot = toPushSnapshot(raw, queuedAt);
    if (snapshot) byId.set(snapshot.eventId, snapshot);
  }
  for (const item of Array.isArray(items) ? items : []) {
    const snapshot = toPushSnapshot(item, queuedAt);
    if (!snapshot) continue;
    const previous = byId.get(snapshot.eventId);
    byId.set(snapshot.eventId, previous ? mergeSnapshot(previous, snapshot) : snapshot);
  }
  return { version: 1, items: Array.from(byId.values()) };
}

export function isChannelDelivered(ledger, eventId, channel) {
  return Boolean(ledger?.events?.[eventId]?.channels?.[channel]?.deliveredAt);
}

export function getPendingChannelItems(queue, ledger, channel) {
  return (queue?.items || []).filter(
    (item) =>
      item?.eventId &&
      (!item.targetChannels?.length || item.targetChannels.includes(channel)) &&
      !isChannelDelivered(ledger, item.eventId, channel)
  );
}

export function recordChannelResult(
  ledger,
  channel,
  items,
  { ok, errorMessage = "" },
  attemptedAt = new Date().toISOString()
) {
  const next = ledger && typeof ledger === "object" ? ledger : createEmptyLedger();
  if (!next.events || typeof next.events !== "object") next.events = {};
  for (const item of items || []) {
    const eventId = eventKey(item);
    if (!eventId) continue;
    const previous = next.events[eventId] || { channels: {} };
    const previousChannel = previous.channels?.[channel] || {};
    next.events[eventId] = {
      ...previous,
      eventId,
      title: String(item.titleZh || item.title || previous.title || ""),
      url: String(item.url || previous.url || ""),
      updatedAt: attemptedAt,
      channels: {
        ...(previous.channels || {}),
        [channel]: {
          ...previousChannel,
          status: ok ? "delivered" : "failed",
          attempts: (Number(previousChannel.attempts) || 0) + 1,
          lastAttemptAt: attemptedAt,
          deliveredAt: ok ? attemptedAt : previousChannel.deliveredAt || null,
          lastError: ok ? "" : String(errorMessage || "unknown error")
        }
      }
    };
  }
  next.version = 1;
  return next;
}

export function removeFullyDeliveredItems(queue, ledger, activeChannels) {
  const channels = (activeChannels || []).filter(Boolean);
  if (!channels.length) return queue || createEmptyQueue();
  return {
    version: 1,
    items: (queue?.items || []).filter(
      (item) => {
        const targets = item?.targetChannels?.length ? item.targetChannels : channels;
        return !targets.every((channel) => isChannelDelivered(ledger, item.eventId, channel));
      }
    )
  };
}

export function pruneDeliveryLedger(
  ledger,
  retentionDays,
  now = new Date(),
  protectedEventIds = []
) {
  const days = Number(retentionDays);
  if (!Number.isFinite(days) || days <= 0) return ledger || createEmptyLedger();
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  const protectedIds = new Set(protectedEventIds || []);
  const next = createEmptyLedger();
  for (const [eventId, entry] of Object.entries(ledger?.events || {})) {
    const updatedAt = new Date(entry?.updatedAt || 0).getTime();
    if (protectedIds.has(eventId) || !Number.isFinite(updatedAt) || updatedAt >= cutoff) {
      next.events[eventId] = entry;
    }
  }
  return next;
}

export async function loadPushQueue() {
  const parsed = await readJson(PUSH_QUEUE_FILE, createEmptyQueue());
  return mergePushQueue(parsed, []);
}

export async function savePushQueue(queue) {
  await writeJson(PUSH_QUEUE_FILE, mergePushQueue(queue, []));
}

export async function loadPushDeliveryLedger() {
  const parsed = await readJson(PUSH_DELIVERY_FILE, createEmptyLedger());
  return parsed?.events && typeof parsed.events === "object" ? parsed : createEmptyLedger();
}

export async function savePushDeliveryLedger(ledger) {
  await writeJson(PUSH_DELIVERY_FILE, {
    version: 1,
    events: ledger?.events && typeof ledger.events === "object" ? ledger.events : {}
  });
}

export function getPushQueuePath() {
  return PUSH_QUEUE_FILE;
}

export function getPushDeliveryPath() {
  return PUSH_DELIVERY_FILE;
}
