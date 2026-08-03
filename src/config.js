import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { validateIanaTimeZone } from "./zoned-time.js";

const TOPICS_FILE = path.resolve(process.cwd(), "topics.yaml");
const SETTINGS_FILE = path.resolve(process.cwd(), "setting.yaml");
const SOURCES_FILE = path.resolve(process.cwd(), "sources.yaml");

function uniqueKeepOrder(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}

function normalizeTopicId(value, index) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || `topic-${index + 1}`;
}

export async function loadTopics() {
  let content;
  try {
    content = await readFile(TOPICS_FILE, "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const parsed = parse(content);
  const rawTopics = Array.isArray(parsed?.topics) ? parsed.topics : [];
  const seenIds = new Set();
  const topics = [];
  for (let index = 0; index < rawTopics.length; index += 1) {
    const raw = rawTopics[index];
    if (!raw || typeof raw !== "object") continue;
    const name = String(raw.name || "").trim();
    const keywords = uniqueKeepOrder(
      (Array.isArray(raw.keywords) ? raw.keywords : [])
        .map((keyword) => String(keyword || "").trim())
        .filter(Boolean)
    );
    const allowedDomains = uniqueKeepOrder(
      (Array.isArray(raw.allowed_domains) ? raw.allowed_domains : [])
        .map((domain) =>
          String(domain || "")
            .trim()
            .toLowerCase()
            .replace(/^https?:\/\//, "")
            .split(/[/?#]/, 1)[0]
            .replace(/^\*\./, "")
            .replace(/^www\./, "")
        )
        .filter(Boolean)
    );
    if (!name || !keywords.length) continue;
    let id = normalizeTopicId(raw.id || name, index);
    if (seenIds.has(id)) id = `${id}-${index + 1}`;
    seenIds.add(id);
    topics.push({
      id,
      name,
      description: String(raw.description || "").trim(),
      enabled: raw.enabled !== false,
      push: raw.push !== false,
      keywords,
      allowedDomains
    });
  }
  return topics;
}

export function getTopicsFilePath() {
  return TOPICS_FILE;
}

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

/** 归档保留天数：默认 7；<=0 表示不按时间清理归档。 */
function parseArchiveRetentionDays(raw, defaultDays = 7) {
  if (raw === undefined || raw === null || raw === "") {
    return defaultDays;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return defaultDays;
  }
  if (n <= 0) {
    return 0;
  }
  return Math.floor(n);
}

function toStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function toBoolean(value, fallback) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(lowered)) {
      return true;
    }
    if (["false", "0", "no", "off"].includes(lowered)) {
      return false;
    }
  }
  return fallback;
}

function isDeepSeekApiUrl(value) {
  try {
    const hostname = new URL(String(value || "")).hostname.toLowerCase();
    return hostname === "api.deepseek.com" || hostname.endsWith(".deepseek.com");
  } catch {
    return /deepseek\.com/i.test(String(value || ""));
  }
}

function normalizeAiApiFormat(value, apiUrl) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "openai" || normalized === "anthropic") {
    return normalized;
  }
  return /anthropic/i.test(String(apiUrl || "")) ? "anthropic" : "openai";
}

function normalizeAiModel(value, apiUrl) {
  const model = String(value || "").trim();
  if (isDeepSeekApiUrl(apiUrl) && ["deepseek-chat", "deepseek-reasoner"].includes(model)) {
    return "deepseek-v4-flash";
  }
  return model;
}

function normalizeThinkingMode(value, apiUrl, configuredModel) {
  if (!isDeepSeekApiUrl(apiUrl)) {
    return "";
  }
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "enabled" || normalized === "disabled") {
    return normalized;
  }
  if (String(configuredModel || "").trim() === "deepseek-reasoner") {
    return "enabled";
  }
  return "disabled";
}

function toStringMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const entries = Object.entries(value)
    .map(([k, v]) => [String(k || "").trim(), String(v || "").trim()])
    .filter(([k, v]) => k && v);
  return Object.fromEntries(entries);
}

function parseTimePartToMinutes(rawHour, rawMinute) {
  const hour = Number(rawHour);
  const minute = Number(rawMinute);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    return null;
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return hour * 60 + minute;
}

function parsePauseTimeRanges(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const ranges = [];
  for (const item of value) {
    const text = String(item || "").trim();
    if (!text) {
      continue;
    }
    const match = text.match(/^(\d{1,2})-(\d{1,2})\s+to\s+(\d{1,2})-(\d{1,2})$/i);
    if (!match) {
      continue;
    }
    const startMinutes = parseTimePartToMinutes(match[1], match[2]);
    const endMinutes = parseTimePartToMinutes(match[3], match[4]);
    if (startMinutes === null || endMinutes === null || startMinutes === endMinutes) {
      continue;
    }
    ranges.push({ startMinutes, endMinutes, text });
  }
  return ranges;
}

function parseDailyTimes(value, fallback = ["12:00", "20:00"]) {
  const source = Array.isArray(value) ? value : fallback;
  const normalized = source
    .map((item) => String(item || "").trim())
    .map((item) => {
      const match = item.match(/^(\d{1,2}):(\d{2})$/);
      if (!match) return null;
      const minutes = parseTimePartToMinutes(match[1], match[2]);
      if (minutes === null) return null;
      return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(
        minutes % 60
      ).padStart(2, "0")}`;
    })
    .filter(Boolean);
  return uniqueKeepOrder(normalized.length ? normalized : fallback).sort();
}

async function readYamlFile(filePath, fallback = {}) {
  try {
    const content = await readFile(filePath, "utf-8");
    const parsed = parse(content);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
    return fallback;
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

export async function loadSettings() {
  const raw = await readYamlFile(SETTINGS_FILE, {});
  const pushConfig = raw.push && typeof raw.push === "object" ? raw.push : {};
  const uiConfig = raw.ui && typeof raw.ui === "object" ? raw.ui : {};
  const newsRetentionConfig =
    raw.news_retention && typeof raw.news_retention === "object" ? raw.news_retention : {};
  const aiTranslationConfig =
    raw.ai_translation && typeof raw.ai_translation === "object" ? raw.ai_translation : {};
  const rankingsConfig =
    raw.rankings && typeof raw.rankings === "object" ? raw.rankings : {};
  const rankingsPushConfig =
    rankingsConfig.push && typeof rankingsConfig.push === "object" ? rankingsConfig.push : {};
  const quietTimeRangesRaw = Array.isArray(pushConfig.quiet_time_ranges)
    ? pushConfig.quiet_time_ranges
    : Array.isArray(pushConfig.pause_time_ranges)
      ? pushConfig.pause_time_ranges
      : raw.pause_time_ranges;

  const timezoneRaw = (process.env.NEWS_TIMEZONE || raw.timezone || "").toString().trim();
  const timezone = validateIanaTimeZone(timezoneRaw);
  const aiApiUrl = (
    process.env.DEEPSEEK_API_URL ||
    process.env.ANTHROPIC_API_URL ||
    aiTranslationConfig.api_url ||
    "https://api.deepseek.com/chat/completions"
  )
    .toString()
    .trim();
  const aiApiFormat = normalizeAiApiFormat(
    process.env.AI_API_FORMAT || process.env.DEEPSEEK_API_FORMAT || aiTranslationConfig.api_format,
    aiApiUrl
  );
  const configuredAiModel =
    process.env.DEEPSEEK_MODEL ||
    process.env.ANTHROPIC_MODEL ||
    aiTranslationConfig.model ||
    "deepseek-v4-flash";
  const aiModel = normalizeAiModel(configuredAiModel, aiApiUrl);

  return {
    fetchIntervalMinutes: toPositiveInt(raw.fetch_interval_minutes, 30),
    minFetchIntervalMinutes: toPositiveInt(raw.min_fetch_interval_minutes, 2),
    requestTimeoutSeconds: toPositiveInt(raw.request_timeout_seconds, 15),
    /** IANA 时区名；空字符串表示使用运行环境的系统本地时区（`Date` 本地分量）。 */
    timezone,
    newsRetention: {
      cleanupIntervalDays: toPositiveInt(newsRetentionConfig.cleanup_interval_days, 7),
      archiveOnCleanup: toBoolean(newsRetentionConfig.archive_on_cleanup, true),
      archiveRetentionDays: parseArchiveRetentionDays(newsRetentionConfig.archive_retention_days, 7)
    },
    aiTranslation: {
      enabled: toBoolean(aiTranslationConfig.enabled, false),
      apiFormat: aiApiFormat,
      apiUrl: aiApiUrl,
      apiKey: (process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_API_KEY || "").toString().trim(),
      model: aiModel,
      thinkingMode: normalizeThinkingMode(
        process.env.DEEPSEEK_THINKING_MODE || aiTranslationConfig.thinking_mode,
        aiApiUrl,
        configuredAiModel
      ),
      anthropicVersion: (aiTranslationConfig.anthropic_version || "2023-06-01").toString().trim(),
      maxItemsPerRun: toPositiveInt(aiTranslationConfig.max_items_per_run, 200),
      batchSize: toPositiveInt(aiTranslationConfig.batch_size, 8),
      requestTimeoutSeconds: toPositiveInt(aiTranslationConfig.request_timeout_seconds, 60),
      onlyNonChinese: toBoolean(aiTranslationConfig.only_non_chinese, true),
      headers: toStringMap(aiTranslationConfig.headers)
    },
    push: {
      enabled: pushConfig.enabled !== false,
      dayAppPushUrl: (process.env.DAY_APP_PUSH_URL || "").toString().trim(),
      ntfyPushUrl: (process.env.NTFY_PUSH_URL || "").toString().trim(),
      sourceBlacklist: toStringArray(pushConfig.source_blacklist),
      maxItemsPerPush: toPositiveInt(pushConfig.max_items_per_push, 20),
      maxMessageChars: toPositiveInt(pushConfig.max_message_chars, 4096),
      quietTimeRanges: parsePauseTimeRanges(quietTimeRangesRaw),
      deliveryLedgerRetentionDays: toPositiveInt(
        pushConfig.delivery_ledger_retention_days,
        30
      )
    },
    rankings: {
      enabled: toBoolean(rankingsConfig.enabled, true),
      apiUrl: (
        process.env.RANKINGS_API_URL ||
        rankingsConfig.api_url ||
        "https://newsnow.busiyi.world/api/s"
      )
        .toString()
        .trim(),
      maxItemsPerPlatform: toPositiveInt(rankingsConfig.max_items_per_platform, 30),
      requestTimeoutSeconds: toPositiveInt(
        rankingsConfig.request_timeout_seconds,
        toPositiveInt(raw.request_timeout_seconds, 15)
      ),
      push: {
        enabled: toBoolean(rankingsPushConfig.enabled, true),
        times: parseDailyTimes(rankingsPushConfig.times),
        itemsPerPlatform: toPositiveInt(rankingsPushConfig.items_per_platform, 3),
        windowMinutes: toPositiveInt(rankingsPushConfig.window_minutes, 90)
      }
    },
    ui: {
      pollIntervalSeconds: toPositiveInt(uiConfig.poll_interval_seconds, 15)
    }
  };
}

function sanitizeSource(source, index) {
  if (!source || typeof source !== "object") {
    return null;
  }
  const type = (source.type || "").toString().trim();
  const url = (source.url || "").toString().trim();
  if (!type || !url) {
    return null;
  }
  const rawHeaders = source.headers && typeof source.headers === "object" ? source.headers : {};
  const headers = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    const headerKey = String(key || "").trim();
    const headerValue = String(value || "").trim();
    if (!headerKey || !headerValue) {
      continue;
    }
    headers[headerKey] = headerValue;
  }
  return {
    id: (source.id || `source_${index + 1}`).toString().trim(),
    name: (source.name || source.id || `来源${index + 1}`).toString().trim(),
    type,
    url,
    headers,
    maxItems: toPositiveInt(source.max_items, 120),
    minTitleLength: toPositiveInt(source.min_title_length, 8),
    maxLinks: toPositiveInt(source.max_links, 60),
    linkSelector: (source.link_selector || "a").toString().trim(),
    method: (source.method || "GET").toString().trim().toUpperCase(),
    itemsPath: (source.items_path || "").toString().trim(),
    titlePath: (source.title_path || "").toString().trim(),
    titlePaths: Array.isArray(source.title_paths)
      ? source.title_paths.map((v) => String(v).trim()).filter(Boolean)
      : [],
    urlPath: (source.url_path || "").toString().trim(),
    urlPaths: Array.isArray(source.url_paths)
      ? source.url_paths.map((v) => String(v).trim()).filter(Boolean)
      : [],
    idPath: (source.id_path || "").toString().trim(),
    idPaths: Array.isArray(source.id_paths)
      ? source.id_paths.map((v) => String(v).trim()).filter(Boolean)
      : [],
    datePath: (source.date_path || "").toString().trim(),
    datePaths: Array.isArray(source.date_paths)
      ? source.date_paths.map((v) => String(v).trim()).filter(Boolean)
      : [],
    urlTemplate: (source.url_template || "").toString().trim(),
    baseUrl: (source.base_url || "").toString().trim(),
    category: (source.category || "").toString().trim(),
    region: (source.region || "").toString().trim(),
    language: (source.language || "").toString().trim()
  };
}

export async function loadSources() {
  const raw = await readYamlFile(SOURCES_FILE, {});
  const sourceList = Array.isArray(raw.sources) ? raw.sources : [];
  const sanitized = sourceList.map(sanitizeSource).filter(Boolean);
  if (sanitized.length > 0) {
    return sanitized;
  }
  return [
    {
      id: "hn_cn",
      name: "HackerNews 中文版",
      type: "html_links",
      url: "https://hn.aimaker.dev/",
      maxItems: 120,
      minTitleLength: 8,
      maxLinks: 60
    },
    {
      id: "newsnow_readme",
      name: "newsnow README 链接",
      type: "markdown_link_pages",
      url: "https://raw.githubusercontent.com/ourongxing/newsnow/main/README.zh-CN.md",
      maxItems: 120,
      minTitleLength: 1,
      maxLinks: 60
    }
  ];
}

export function getSettingsFilePath() {
  return SETTINGS_FILE;
}

export function getSourcesFilePath() {
  return SOURCES_FILE;
}
