import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

const KEYWORD_FILE = path.resolve(process.cwd(), "keywords.yaml");
const SETTINGS_FILE = path.resolve(process.cwd(), "setting.yaml");
const SOURCES_FILE = path.resolve(process.cwd(), "sources.yaml");

function normalizeKeyword(raw) {
  const cleaned = raw.replace(/^-+\s*/, "").trim();
  return cleaned;
}

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

export async function loadKeywords() {
  let content = "";
  try {
    content = await readFile(KEYWORD_FILE, "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return { keywords: [], priorityKeywords: [] };
    }
    throw error;
  }

  const lines = content.split(/\r?\n/);
  const keywords = [];
  const priorityKeywords = [];
  let inPrioritySection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    if (trimmed === "=======") {
      inPrioritySection = true;
      continue;
    }
    const normalized = normalizeKeyword(trimmed);
    if (!normalized) {
      continue;
    }
    if (inPrioritySection) {
      priorityKeywords.push(normalized);
    } else {
      keywords.push(normalized);
    }
  }

  return {
    keywords: uniqueKeepOrder(keywords),
    priorityKeywords: uniqueKeepOrder(priorityKeywords)
  };
}

export function getKeywordFilePath() {
  return KEYWORD_FILE;
}

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
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

  return {
    fetchIntervalMinutes: toPositiveInt(raw.fetch_interval_minutes, 30),
    minFetchIntervalMinutes: toPositiveInt(raw.min_fetch_interval_minutes, 2),
    requestTimeoutSeconds: toPositiveInt(raw.request_timeout_seconds, 15),
    push: {
      enabled: pushConfig.enabled !== false,
      dayAppPushUrl:
        (process.env.DAY_APP_PUSH_URL || pushConfig.day_app_push_url || "").toString().trim(),
      repeatIntervalMinutes: toPositiveInt(pushConfig.repeat_interval_minutes, 1440),
      maxItemsPerPush: toPositiveInt(pushConfig.max_items_per_push, 15)
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
    waitForSelector: (source.wait_for_selector || "").toString().trim(),
    linkSelector: (source.link_selector || "a").toString().trim(),
    browserWaitMs: toPositiveInt(source.browser_wait_ms, 8_000),
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
    baseUrl: (source.base_url || "").toString().trim()
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
