import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { deliverMarkdownMessage, getActivePushChannels } from "./push-service.js";
import { getLocalDateKey, getMinutesOfDayInZone } from "./zoned-time.js";

const DATA_DIR = path.resolve(process.cwd(), "data");
const RANKINGS_FILE = path.resolve(DATA_DIR, "rankings.json");

export const RANKING_PLATFORMS = [
  {
    key: "weibo",
    id: "weibo",
    name: "微博",
    domains: ["weibo.com"]
  },
  {
    key: "douyin",
    id: "douyin",
    name: "抖音",
    domains: ["douyin.com"]
  },
  {
    key: "bilibili",
    id: "bilibili-hot-search",
    name: "Bilibili",
    domains: ["bilibili.com"]
  }
];

export function createEmptyRankings() {
  return {
    version: 1,
    generatedAt: null,
    checkedAt: null,
    platforms: {},
    pushSlots: {}
  };
}

function normalizeSnapshot(value) {
  const fallback = createEmptyRankings();
  if (!value || typeof value !== "object") return fallback;
  return {
    version: 1,
    generatedAt: value.generatedAt || null,
    checkedAt: value.checkedAt || null,
    platforms: value.platforms && typeof value.platforms === "object" ? value.platforms : {},
    pushSlots: value.pushSlots && typeof value.pushSlots === "object" ? value.pushSlots : {}
  };
}

export async function loadRankings() {
  try {
    return normalizeSnapshot(JSON.parse(await readFile(RANKINGS_FILE, "utf-8")));
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`[NewsLive rankings] 无法读取旧快照，将使用空快照: ${error.message}`);
    }
    return createEmptyRankings();
  }
}

export async function saveRankings(snapshot) {
  await mkdir(DATA_DIR, { recursive: true });
  const tempPath = `${RANKINGS_FILE}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(normalizeSnapshot(snapshot), null, 2), "utf-8");
    await rename(tempPath, RANKINGS_FILE);
  } finally {
    await unlink(tempPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

function isAllowedUrl(value, domains) {
  try {
    const url = new URL(String(value || ""));
    const hostname = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))
    );
  } catch {
    return false;
  }
}

function pickItemUrl(item, domains) {
  return [item?.url, item?.mobileUrl].find((url) => isAllowedUrl(url, domains)) || "";
}

function normalizeTitle(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function previousRankMap(platform) {
  const byUrl = new Map();
  const byTitle = new Map();
  for (const item of platform?.items || []) {
    if (item?.url) byUrl.set(item.url, Number(item.rank));
    const title = normalizeTitle(item?.title).toLowerCase();
    if (title) byTitle.set(title, Number(item.rank));
  }
  return { byUrl, byTitle };
}

async function fetchRankingResponse(url, timeoutMs, fetchImpl) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        // 接口位于 Cloudflare 后方，会拒绝非浏览器默认 UA；这里只发送普通 HTTP
        // 请求头，不启动浏览器，也不绕过登录或付费限制。
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138 Safari/537.36",
          Accept: "application/json,text/plain,*/*",
          Referer: "https://newsnow.busiyi.world/"
        },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("榜单接口请求失败");
}

async function fetchPlatform(definition, previous, settings, now, fetchImpl) {
  const apiUrl = String(settings.apiUrl || "").replace(/[?&]+$/, "");
  if (!apiUrl) throw new Error("未配置榜单接口");
  const separator = apiUrl.includes("?") ? "&" : "?";
  const url = `${apiUrl}${separator}id=${encodeURIComponent(definition.id)}&latest`;
  const response = await fetchRankingResponse(
    url,
    settings.requestTimeoutMs || 15_000,
    fetchImpl
  );
  const payload = await response.json();
  if (!['success', 'cache'].includes(String(payload?.status || "").toLowerCase())) {
    throw new Error(`接口状态异常: ${payload?.status || "unknown"}`);
  }
  if (!Array.isArray(payload.items)) throw new Error("接口未返回榜单条目");

  const oldRanks = previousRankMap(previous);
  const seen = new Set();
  const items = [];
  for (const rawItem of payload.items) {
    const title = normalizeTitle(rawItem?.title);
    const itemUrl = pickItemUrl(rawItem, definition.domains);
    const key = itemUrl || title.toLowerCase();
    if (!title || !itemUrl || seen.has(key)) continue;
    seen.add(key);
    const rank = items.length + 1;
    const oldRank = oldRanks.byUrl.get(itemUrl) || oldRanks.byTitle.get(title.toLowerCase()) || null;
    items.push({
      title,
      url: itemUrl,
      rank,
      previousRank: oldRank,
      rankChange: oldRank ? oldRank - rank : null,
      isNew: !oldRank
    });
    if (items.length >= settings.maxItemsPerPlatform) break;
  }
  if (!items.length) throw new Error("接口条目未通过标题或域名校验");
  const upstreamUpdatedDate = new Date(Number(payload.updatedTime));
  const updatedAt = Number.isFinite(upstreamUpdatedDate.getTime())
    ? upstreamUpdatedDate.toISOString()
    : now.toISOString();

  return {
    id: definition.key,
    name: definition.name,
    status: "success",
    upstreamStatus: String(payload.status).toLowerCase(),
    stale: false,
    errorMessage: "",
    checkedAt: now.toISOString(),
    updatedAt,
    items
  };
}

export async function refreshRankings(
  previousSnapshot,
  settings,
  { now = new Date(), fetchImpl = fetch } = {}
) {
  const previous = normalizeSnapshot(previousSnapshot);
  if (!settings?.enabled) return previous;
  const settled = await Promise.allSettled(
    RANKING_PLATFORMS.map((definition) =>
      fetchPlatform(
        definition,
        previous.platforms[definition.key],
        settings,
        now,
        fetchImpl
      )
    )
  );
  const platforms = {};
  let successCount = 0;
  for (let index = 0; index < RANKING_PLATFORMS.length; index += 1) {
    const definition = RANKING_PLATFORMS[index];
    const result = settled[index];
    if (result.status === "fulfilled") {
      platforms[definition.key] = result.value;
      successCount += 1;
      continue;
    }
    const prior = previous.platforms[definition.key];
    platforms[definition.key] = {
      id: definition.key,
      name: definition.name,
      status: "failed",
      upstreamStatus: prior?.upstreamStatus || "",
      stale: Boolean(prior?.items?.length),
      errorMessage: result.reason?.message || "榜单获取失败",
      checkedAt: now.toISOString(),
      updatedAt: prior?.updatedAt || null,
      items: Array.isArray(prior?.items) ? prior.items : []
    };
  }
  return {
    ...previous,
    generatedAt: successCount ? now.toISOString() : previous.generatedAt,
    checkedAt: now.toISOString(),
    platforms
  };
}

function escapeMarkdownText(value) {
  return String(value || "")
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)");
}

function escapeMarkdownUrl(value) {
  return String(value || "").replaceAll(" ", "%20").replaceAll("(", "%28").replaceAll(")", "%29");
}

export function buildRankingPushMessage(snapshot, itemsPerPlatform = 3, slotLabel = "") {
  const markdownBlocks = [];
  const plainBlocks = [];
  for (const definition of RANKING_PLATFORMS) {
    const platform = snapshot?.platforms?.[definition.key];
    if (platform?.status !== "success") continue;
    const items = (platform.items || []).slice(0, Math.max(1, itemsPerPlatform));
    if (!items.length) continue;
    markdownBlocks.push(
      `**${definition.name}**\n${items
        .map(
          (item, index) =>
            `${index + 1}. [${definition.name}] [${escapeMarkdownText(item.title)}](${escapeMarkdownUrl(item.url)})`
        )
        .join("\n")}`
    );
    plainBlocks.push(
      `${definition.name}\n${items
        .map((item, index) => `${index + 1}. [${definition.name}] ${item.title}`)
        .join("\n")}`
    );
  }
  return {
    title: `NewsLive 国内热榜${slotLabel ? ` · ${slotLabel}` : ""}`,
    markdown: markdownBlocks.join("\n\n"),
    plain: plainBlocks.join("\n\n")
  };
}

export function getDueRankingPushSlot(now, rankingsSettings, timeZone = "") {
  if (!rankingsSettings?.push?.enabled) return null;
  const currentMinutes = getMinutesOfDayInZone(now, timeZone);
  const candidates = (rankingsSettings.push.times || [])
    .map((time) => {
      const [hour, minute] = String(time).split(":").map(Number);
      return { time, minutes: hour * 60 + minute };
    })
    .filter(
      ({ minutes }) =>
        Number.isFinite(minutes) &&
        currentMinutes >= minutes &&
        currentMinutes - minutes <= rankingsSettings.push.windowMinutes
    )
    .sort((a, b) => b.minutes - a.minutes);
  const due = candidates[0];
  if (!due) return null;
  const dateKey = getLocalDateKey(now, timeZone);
  return { key: `${dateKey}@${due.time}`, dateKey, time: due.time };
}

function prunePushSlots(pushSlots) {
  return Object.fromEntries(Object.entries(pushSlots || {}).sort(([a], [b]) => a.localeCompare(b)).slice(-12));
}

export async function maybePushRankings(
  snapshot,
  settings,
  { now = new Date(), fetchImpl = fetch } = {}
) {
  const dueSlot = getDueRankingPushSlot(now, settings?.rankings, settings?.timezone || "");
  const activeChannels = getActivePushChannels(settings);
  if (!dueSlot || !activeChannels.length) {
    return { snapshot, dueSlot, delivered: [], errors: [] };
  }
  const existingSlot = snapshot.pushSlots?.[dueSlot.key] || { channels: {} };
  const pendingChannels = activeChannels.filter(
    (channel) => existingSlot.channels?.[channel]?.status !== "delivered"
  );
  if (!pendingChannels.length) {
    return { snapshot, dueSlot, delivered: [], errors: [] };
  }
  const message = buildRankingPushMessage(
    snapshot,
    settings.rankings.push.itemsPerPlatform,
    dueSlot.time
  );
  if (!message.markdown) {
    return { snapshot, dueSlot, delivered: [], errors: ["没有可推送的最新榜单"] };
  }
  const delivery = await deliverMarkdownMessage({
    ...message,
    group: "NewsLive 热榜",
    settings,
    targetChannels: pendingChannels,
    fetchImpl
  });
  const attemptedAt = now.toISOString();
  const channels = { ...(existingSlot.channels || {}) };
  for (const channel of pendingChannels) {
    const result = delivery.results[channel];
    channels[channel] = result?.ok
      ? { status: "delivered", deliveredAt: attemptedAt, lastError: "" }
      : {
          status: "failed",
          lastAttemptAt: attemptedAt,
          lastError: result?.errorMessage || "推送失败"
        };
  }
  const nextSnapshot = {
    ...snapshot,
    pushSlots: prunePushSlots({
      ...(snapshot.pushSlots || {}),
      [dueSlot.key]: { slot: dueSlot.time, dateKey: dueSlot.dateKey, channels }
    })
  };
  return {
    snapshot: nextSnapshot,
    dueSlot,
    delivered: delivery.delivered,
    errors: delivery.errors
  };
}

export function summarizeRankings(snapshot) {
  return RANKING_PLATFORMS.map((definition) => {
    const platform = snapshot?.platforms?.[definition.key] || {};
    return {
      id: definition.key,
      name: definition.name,
      status: platform.status || "pending",
      stale: Boolean(platform.stale),
      itemCount: Array.isArray(platform.items) ? platform.items.length : 0,
      updatedAt: platform.updatedAt || null,
      errorMessage: platform.errorMessage || ""
    };
  });
}

export function getRankingsPath() {
  return RANKINGS_FILE;
}
