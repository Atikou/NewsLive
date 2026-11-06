import {
  getPendingChannelItems,
  recordChannelResult,
  removeFullyDeliveredItems
} from "./push-store.js";

function utf8Length(text) {
  return Buffer.byteLength(String(text || ""), "utf8");
}

function escapeMarkdownText(text) {
  return String(text || "")
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)");
}

function escapeMarkdownUrl(url) {
  return String(url || "").replaceAll(" ", "%20").replaceAll("(", "%28").replaceAll(")", "%29");
}

function formatItemTime(item, timeZone = "") {
  const value = String(item?.pubDate || item?.fetchedAt || "").trim();
  if (!value) return "";
  const date = new Date(value);
  if (Number.isFinite(date.getTime())) {
    try {
      const parts = Object.fromEntries(
        new Intl.DateTimeFormat("zh-CN", {
          ...(timeZone ? { timeZone } : {}),
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23"
        })
          .formatToParts(date)
          .map((part) => [part.type, part.value])
      );
      return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
    } catch {
      // 无效时区时继续使用稳定的 ISO 紧凑格式。
    }
  }
  return value.includes("T") && value.length >= 16 ? value.replace("T", " ").slice(0, 16) : value;
}

function buildPushLine(item, index, { markdown = true, timeZone = "" } = {}) {
  const title = escapeMarkdownText(item?.titleZh || item?.title || "未命名新闻");
  const url = escapeMarkdownUrl(item?.url || "");
  const titleLink = markdown && url ? `[${title}](${url})` : title;
  const sourceList = Array.from(
    new Set([item?.source, ...(item?.relatedSources || [])].filter(Boolean))
  );
  const sources = sourceList.length > 1
    ? `${sourceList[0]} 等 ${sourceList.length} 个来源`
    : sourceList[0] || "来源未知";
  const sourceLabel = `[${escapeMarkdownText(sources)}]`;
  const tags = (item?.matchedPushTopics || []).join("、");
  const meta = [formatItemTime(item, timeZone), tags ? `#${tags.replaceAll("、", " #")}` : ""]
    .filter(Boolean)
    .join(" · ");
  return `${index}. ${sourceLabel} ${titleLink}${meta ? `\n   ${meta}` : ""}`;
}

function truncateUtf8(text, maxBytes) {
  let result = String(text || "");
  while (result.length > 1 && utf8Length(`${result}…`) > maxBytes) result = result.slice(0, -1);
  return utf8Length(result) > maxBytes ? "" : `${result}…`;
}

export function buildPushMessage(items, maxMessageChars = 4096, options = {}) {
  const maxBytes = Math.max(512, Number(maxMessageChars) || 4096);
  const lines = [];
  const usedItems = [];
  for (const item of items) {
    const line = buildPushLine(item, usedItems.length + 1, options);
    if (utf8Length([...lines, line].join("\n")) <= maxBytes) {
      lines.push(line);
      usedItems.push(item);
      continue;
    }
    if (!usedItems.length) {
      lines.push(truncateUtf8(line, maxBytes));
      usedItems.push(item);
    }
    break;
  }
  return { message: lines.join("\n"), usedItems };
}

function buildDayAppUrl(pushUrl, title, body) {
  if (pushUrl.includes("{title}") || pushUrl.includes("{body}")) {
    return pushUrl
      .replaceAll("{title}", encodeURIComponent(title))
      .replaceAll("{body}", encodeURIComponent(body));
  }
  try {
    const url = new URL(pushUrl);
    const pathBase = url.pathname.replace(/\/+$/, "");
    if (!pathBase || pathBase === "/") throw new Error("missing device key");
    return `${url.origin}${pathBase}/${encodeURIComponent(title)}/${encodeURIComponent(body)}${url.search}${url.hash}`;
  } catch {
    const separator = pushUrl.includes("?") ? "&" : "?";
    return `${pushUrl}${separator}title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  }
}

async function sendDayAppMessage(
  url,
  { title, markdown, plain = markdown, group = "NewsLive" },
  fetchImpl
) {
  if (!String(markdown || "").trim()) {
    return { ok: false, errorMessage: "day.app push has no content" };
  }
  try {
    let response;
    if (url.includes("{title}") || url.includes("{body}")) {
      const fullUrl = buildDayAppUrl(url, title, markdown);
      if (fullUrl.length > 3_800) {
        return { ok: false, errorMessage: "day.app template URL is too large" };
      }
      response = await fetchImpl(fullUrl, {
        method: "GET",
        headers: { "User-Agent": "NewsLive/1.0" }
      });
    } else {
      const payload = {
        title,
        body: plain,
        markdown,
        group
      };
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "User-Agent": "NewsLive/1.0"
        },
        body: JSON.stringify(payload)
      });
    }
    return response.ok
      ? { ok: true, errorMessage: "" }
      : { ok: false, errorMessage: `day.app push failed (${response.status})` };
  } catch (error) {
    return {
      ok: false,
      errorMessage: `day.app push error (${error.message || "unknown"})`
    };
  }
}

async function sendDayApp(url, items, maxMessageChars, timeZone, fetchImpl) {
  const built = buildPushMessage(items, maxMessageChars, { markdown: true, timeZone });
  const usedItems = built.usedItems;
  if (!usedItems.length) return { ok: false, errorMessage: "day.app push has no content", usedItems };
  const result = await sendDayAppMessage(
    url,
    {
      title: `NewsLive 重点新闻 ${usedItems.length} 条`,
      markdown: built.message,
      plain: buildPushMessage(usedItems, maxMessageChars, {
        markdown: false,
        timeZone
      }).message
    },
    fetchImpl
  );
  return { ...result, usedItems };
}

function encodeRfc2047(value) {
  return `=?UTF-8?B?${Buffer.from(String(value || ""), "utf8").toString("base64")}?=`;
}

async function sendNtfy(url, message, title, fetchImpl) {
  const headers = {
    "Content-Type": "text/markdown; charset=utf-8",
    "User-Agent": "NewsLive/1.0",
    Markdown: "yes",
    Title: encodeRfc2047(title)
  };
  const token = String(process.env.NTFY_BEARER_TOKEN || "").trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const response = await fetchImpl(url, { method: "POST", headers, body: message });
    return response.ok
      ? { ok: true, errorMessage: "" }
      : { ok: false, errorMessage: `ntfy push failed (${response.status})` };
  } catch (error) {
    return { ok: false, errorMessage: `ntfy push error (${error.message || "unknown"})` };
  }
}

export function getActivePushChannels(settings) {
  if (!settings?.push?.enabled) return [];
  const channels = [];
  if (settings.push.dayAppPushUrl) channels.push("dayApp");
  if (settings.push.ntfyPushUrl) channels.push("ntfy");
  return channels;
}

export async function deliverMarkdownMessage({
  title,
  markdown,
  plain = markdown,
  group = "NewsLive",
  settings,
  targetChannels,
  fetchImpl = fetch
}) {
  const activeChannels = getActivePushChannels(settings);
  const requested = Array.isArray(targetChannels) ? new Set(targetChannels) : null;
  const channels = requested
    ? activeChannels.filter((channel) => requested.has(channel))
    : activeChannels;
  const results = {};
  for (const channel of channels) {
    results[channel] = channel === "dayApp"
      ? await sendDayAppMessage(
          settings.push.dayAppPushUrl,
          { title, markdown, plain, group },
          fetchImpl
        )
      : await sendNtfy(settings.push.ntfyPushUrl, markdown, title, fetchImpl);
  }
  return {
    results,
    delivered: channels.filter((channel) => results[channel]?.ok),
    errors: channels.map((channel) => results[channel]?.errorMessage).filter(Boolean),
    activeChannels: channels
  };
}

export async function deliverQueuedPushes({
  queue,
  ledger,
  settings,
  fetchImpl = fetch,
  now = new Date(),
  onProgress = async () => {}
}) {
  const channels = getActivePushChannels(settings);
  const errors = [];
  const delivered = [];
  let nextLedger = ledger;
  for (const channel of channels) {
    const pending = getPendingChannelItems(queue, nextLedger, channel);
    let cursor = 0;
    while (cursor < pending.length) {
      const candidates = pending.slice(cursor, cursor + settings.push.maxItemsPerPush);
      const { message, usedItems } = buildPushMessage(candidates, settings.push.maxMessageChars, {
        markdown: true,
        timeZone: settings.timezone || ""
      });
      if (!usedItems.length) break;
      const result = channel === "dayApp"
        ? await sendDayApp(
            settings.push.dayAppPushUrl,
            usedItems,
            settings.push.maxMessageChars,
            settings.timezone || "",
            fetchImpl
          )
        : await sendNtfy(
            settings.push.ntfyPushUrl,
            message,
            `NewsLive 重点新闻 ${usedItems.length} 条`,
            fetchImpl
          );
      const attemptedItems = result.usedItems || usedItems;
      nextLedger = recordChannelResult(
        nextLedger,
        channel,
        attemptedItems,
        result,
        now.toISOString()
      );
      await onProgress({ queue, ledger: nextLedger });
      if (!result.ok) {
        errors.push(result.errorMessage);
        break;
      }
      delivered.push(...attemptedItems.map((item) => ({ eventId: item.eventId, channel })));
      cursor += attemptedItems.length;
    }
  }
  const nextQueue = removeFullyDeliveredItems(queue, nextLedger, channels);
  await onProgress({ queue: nextQueue, ledger: nextLedger });
  return { queue: nextQueue, ledger: nextLedger, errors, delivered, activeChannels: channels };
}
