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

export function buildPushMessage(items, maxMessageChars = 4096, options = {}) {
  const maxBytes = Math.min(4096, Math.max(512, Number(maxMessageChars) || 4096));
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
      return { message: line, usedItems: [item], errorMessage: "single news item exceeds message size limit" };
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

function buildDayAppPayload({ title, markdown, plain = markdown, group = "NewsLive" }) {
  return { title, body: plain, markdown, group };
}

function getDayAppSizeError(url, message) {
  if (url.includes("{title}") || url.includes("{body}")) {
    return buildDayAppUrl(url, message.title, message.markdown).length > 3_800
      ? "day.app template URL is too large"
      : "";
  }
  const payload = { ...buildDayAppPayload(message), ...Object.fromEntries(new URL(url).searchParams) };
  // Bark 的 APNs 包同时携带 body、markdown，并额外写入 aps 与 thread-id。
  // Go 的 JSON 编码还会转义 HTML 字符；为服务端封装保留 512 字节。
  const serialized = JSON.stringify(payload).replace(/[<>&\u2028\u2029]/g, (char) =>
    `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
  return utf8Length(serialized) + utf8Length(JSON.stringify(payload.group || "")) > 4096 - 512
    ? "day.app payload exceeds APNs 4096-byte limit (including body and markdown)"
    : "";
}

async function getDayAppResponseError(response) {
  // 状态会发布到 Pages；只记录已知错误类型，不公开可能含设备 key 的原始响应。
  let reason = "";
  try {
    const body = await response.json();
    reason = String(body?.message || "").match(/\b(PayloadTooLarge|BadDeviceToken|Unregistered|DeviceTokenNotForTopic|ExpiredProviderToken|InvalidProviderToken|TooManyRequests|ServiceUnavailable|Shutdown)\b/)?.[1] || "";
  } catch {
    // 无 JSON 的网关错误仍保留 HTTP 状态。
  }
  return `day.app push failed (${response.status})${reason ? `: ${reason}` : ""}`;
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
    const message = { title, markdown, plain, group };
    const sizeError = getDayAppSizeError(url, message);
    if (sizeError) return { ok: false, errorMessage: sizeError };
    let response;
    if (url.includes("{title}") || url.includes("{body}")) {
      const fullUrl = buildDayAppUrl(url, title, markdown);
      response = await fetchImpl(fullUrl, {
        method: "GET",
        headers: { "User-Agent": "NewsLive/1.0" }
      });
    } else {
      const payload = buildDayAppPayload(message);
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
      : { ok: false, errorMessage: await getDayAppResponseError(response) };
  } catch (error) {
    return {
      ok: false,
      errorMessage: `day.app push error (${error.message || "unknown"})`
    };
  }
}

async function sendDayApp(url, items, maxMessageChars, timeZone, fetchImpl) {
  let usedItems = items.slice();
  let message;
  try {
    while (usedItems.length) {
      message = {
        title: `NewsLive 重点新闻 ${usedItems.length} 条`,
        markdown: usedItems.map((item, index) => buildPushLine(item, index + 1, { timeZone })).join("\n"),
        plain: usedItems.map((item, index) => buildPushLine(item, index + 1, { markdown: false, timeZone })).join("\n")
      };
      const sizeError = getDayAppSizeError(url, message) ||
        (utf8Length(message.markdown) > Math.max(512, Number(maxMessageChars) || 4096)
          ? "day.app single news item exceeds message size limit" : "");
      if (!sizeError) break;
      // 单条也放不下时保留失败状态，不能截断超链接后假记为已送达。
      if (usedItems.length === 1) return { ok: false, errorMessage: sizeError, usedItems, itemTooLarge: true };
      usedItems.pop();
    }
  } catch {
    return { ok: false, errorMessage: "day.app push URL is invalid", usedItems };
  }
  if (!usedItems.length) return { ok: false, errorMessage: "day.app push has no content", usedItems };
  const result = await sendDayAppMessage(url, message, fetchImpl);
  return { ...result, usedItems };
}

function encodeRfc2047(value) {
  return `=?UTF-8?B?${Buffer.from(String(value || ""), "utf8").toString("base64")}?=`;
}

async function sendNtfy(url, message, title, fetchImpl) {
  if (utf8Length(message) > 4096) {
    return { ok: false, errorMessage: "ntfy message exceeds 4096-byte limit" };
  }
  if (utf8Length(title) > 1024) {
    return { ok: false, errorMessage: "ntfy title exceeds 1024-byte limit" };
  }
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
      const { message, usedItems, errorMessage } = buildPushMessage(candidates, settings.push.maxMessageChars, {
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
        : errorMessage
          ? { ok: false, errorMessage: `ntfy ${errorMessage}`, itemTooLarge: true }
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
        if (result.itemTooLarge) {
          cursor += attemptedItems.length;
          continue;
        }
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
