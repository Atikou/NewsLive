import * as cheerio from "cheerio";

function withTimeout(url, timeoutMs, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => {
    clearTimeout(timeoutId);
  });
}

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

async function fetchWithRetry(url, timeoutMs, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await withTimeout(url, timeoutMs, options);
      if (
        response.ok ||
        !RETRYABLE_HTTP_STATUSES.has(response.status) ||
        attempt === 1
      ) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status} on ${url}`);
    } catch (error) {
      lastError = error;
      if (attempt === 1) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError || new Error(`获取失败: ${url}`);
}

function normalizeUrl(value, baseUrl) {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return null;
  }
}

function collectUniqueByKey(items, keyFn) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}

function getByPath(target, path) {
  if (!path) {
    return target;
  }
  return path.split(".").reduce((acc, part) => {
    if (acc === null || acc === undefined) {
      return undefined;
    }
    return acc[part];
  }, target);
}

function firstNonEmptyValue(target, paths = []) {
  for (const path of paths) {
    const value = getByPath(target, path);
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value;
    }
  }
  return undefined;
}

function applyRuntimePlaceholders(text) {
  const now = Date.now();
  return String(text).replaceAll("{now}", String(now)).replaceAll("{timestamp}", String(now));
}

function resolveTemplate(template, item) {
  return String(template).replace(/\{([^}]+)\}/g, (_, token) => {
    const value = getByPath(item, token.trim());
    if (value === undefined || value === null) {
      return "";
    }
    return String(value);
  });
}

function toAbsoluteUrl(url, baseUrl) {
  try {
    if (!url) {
      return null;
    }
    if (baseUrl) {
      return new URL(url, baseUrl).toString();
    }
    return new URL(url).toString();
  } catch {
    return null;
  }
}

function parseMarkdownLinks(markdownText, maxLinks) {
  const links = [];
  const markdownLinkRegex = /\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/g;
  const plainUrlRegex = /https?:\/\/[^\s)]+/g;

  let match;
  while ((match = markdownLinkRegex.exec(markdownText)) !== null) {
    links.push(match[1]);
  }
  while ((match = plainUrlRegex.exec(markdownText)) !== null) {
    links.push(match[0]);
  }

  return collectUniqueByKey(
    links
      .map((link) => link.replace(/[),.;]+$/, ""))
      .filter(
        (link) =>
          !link.includes(".png") &&
          !link.includes(".jpg") &&
          !link.includes(".gif") &&
          !link.includes(".svg")
      ),
    (item) => item
  ).slice(0, maxLinks);
}

async function fetchText(url, timeoutMs, extraHeaders = {}) {
  const finalUrl = applyRuntimePlaceholders(url);
  const response = await fetchWithRetry(finalUrl, timeoutMs, {
    headers: {
      "User-Agent": "NewsLiveBot/1.0",
      ...extraHeaders
    }
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} on ${url}`);
  }
  return response.text();
}

async function fetchJson(source, timeoutMs) {
  const finalUrl = applyRuntimePlaceholders(source.url);
  const response = await fetchWithRetry(finalUrl, timeoutMs, {
    method: source.method || "GET",
    headers: {
      "User-Agent": "NewsLiveBot/1.0",
      ...source.headers
    }
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} on ${finalUrl}`);
  }
  return response.json();
}

function extractHtmlLinks(html, source) {
  const $ = cheerio.load(html);
  const cards = [];
  const now = new Date().toISOString();
  const selector = source.linkSelector || "a";

  $(selector).each((_, element) => {
    const title = $(element).text().replace(/\s+/g, " ").trim();
    const href = $(element).attr("href");
    if (!title || title.length < source.minTitleLength || !href) {
      return;
    }
    cards.push({
      title,
      url: normalizeUrl(href, source.url) || source.url,
      source: source.name,
      fetchedAt: now
    });
  });

  return collectUniqueByKey(cards, (item) => `${item.title}|${item.url}`).slice(0, source.maxItems);
}

function extractPageTitle(html) {
  const $ = cheerio.load(html);
  return $("title").first().text().replace(/\s+/g, " ").trim();
}

function extractRssItems(xml, source) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const now = new Date().toISOString();
  const items = [];

  $("item").each((_, element) => {
    const title = $(element).find("title").first().text().replace(/\s+/g, " ").trim();
    const link = $(element).find("link").first().text().trim();
    const pubDate = $(element).find("pubDate").first().text().trim()
      || $(element).find("dc\\:date").first().text().trim()
      || $(element).find("updated").first().text().trim();
    if (!title || title.length < source.minTitleLength || !link) {
      return;
    }
    items.push({
      title,
      url: link,
      source: source.name,
      fetchedAt: now,
      pubDate: pubDate || undefined
    });
  });

  return collectUniqueByKey(items, (item) => `${item.title}|${item.url}`).slice(0, source.maxItems);
}

function hasUsablePublishedDate(item) {
  if (!item?.pubDate) return false;
  return Number.isFinite(new Date(item.pubDate).getTime());
}

async function crawlMarkdownLinkedPages(source, timeoutMs) {
  const markdown = await fetchText(source.url, timeoutMs, source.headers);
  const links = parseMarkdownLinks(markdown, source.maxLinks);
  const now = new Date().toISOString();

  const results = await Promise.allSettled(
    links.map(async (link) => {
      try {
        const html = await fetchText(link, timeoutMs, source.headers);
        const title = extractPageTitle(html) || link;
        return {
          title,
          url: link,
          source: source.name,
          fetchedAt: now
        };
      } catch {
        return {
          title: `无法获取页面: ${link}`,
          url: link,
          source: source.name,
          fetchedAt: now
        };
      }
    })
  );

  return results
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value)
    .slice(0, source.maxItems);
}

async function crawlJsonItems(source, timeoutMs) {
  const payload = await fetchJson(source, timeoutMs);
  const list = source.itemsPath ? getByPath(payload, source.itemsPath) : payload;
  const items = Array.isArray(list) ? list : [];
  const now = new Date().toISOString();
  const titleCandidates = [
    source.titlePath,
    ...source.titlePaths,
    "title",
    "name",
    "text"
  ].filter(Boolean);
  const urlCandidates = [source.urlPath, ...source.urlPaths, "url", "link"].filter(Boolean);
  const idCandidates = [source.idPath, ...source.idPaths, "id"].filter(Boolean);
  const dateCandidates = [source.datePath, ...source.datePaths, "pubDate", "time", "created_at"].filter(
    Boolean
  );

  const mapped = items
    .map((item, index) => {
      const titleValue = firstNonEmptyValue(item, titleCandidates);
      const rawUrl = source.urlTemplate
        ? resolveTemplate(source.urlTemplate, item)
        : firstNonEmptyValue(item, urlCandidates);
      const idValue = firstNonEmptyValue(item, idCandidates) || rawUrl || `json_${index}`;
      const dateValue = firstNonEmptyValue(item, dateCandidates);
      const absoluteUrl = toAbsoluteUrl(String(rawUrl || ""), source.baseUrl || source.url);
      const title = titleValue ? String(titleValue).replace(/\s+/g, " ").trim() : "";
      if (!title || !absoluteUrl || title.length < source.minTitleLength) {
        return null;
      }
      return {
        id: String(idValue),
        title,
        url: absoluteUrl,
        source: source.name,
        fetchedAt: now,
        pubDate: dateValue ? String(dateValue) : undefined
      };
    })
    .filter(Boolean);

  return collectUniqueByKey(mapped, (item) => `${item.title}|${item.url}`).slice(0, source.maxItems);
}

async function crawlSingleSource(source, timeoutMs) {
  if (source.type === "html_links") {
    const html = await fetchText(source.url, timeoutMs, source.headers);
    return extractHtmlLinks(html, source);
  }
  if (source.type === "rss") {
    const xml = await fetchText(source.url, timeoutMs, source.headers);
    return extractRssItems(xml, source);
  }
  if (source.type === "json_items") {
    return crawlJsonItems(source, timeoutMs);
  }
  if (source.type === "markdown_link_pages") {
    return crawlMarkdownLinkedPages(source, timeoutMs);
  }
  throw new Error(`不支持的来源类型: ${source.type} (${source.id})`);
}

function classifySourceHealthByError(errorMessage) {
  const message = String(errorMessage || "").toLowerCase();
  if (
    message.includes("fetch failed") ||
    message.includes("http ") ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("econn") ||
    message.includes("enotfound") ||
    message.includes("net::")
  ) {
    return "failed";
  }
  return "other";
}

export async function crawlAllSources({ sources, requestTimeoutMs }) {
  const results = await Promise.allSettled(
    sources.map((source) => crawlSingleSource(source, requestTimeoutMs))
  );
  const items = [];
  const errors = [];
  const sourceResults = [];
  const checkedAt = new Date().toISOString();

  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    const source = sources[index];
    if (result.status === "fulfilled") {
      const sourceItems = (Array.isArray(result.value) ? result.value : []).map((item) => ({
        ...item,
        ...(source.category ? { category: source.category } : {}),
        ...(source.region ? { region: source.region } : {}),
        ...(source.language ? { language: source.language } : {})
      }));
      const usableItemCount = sourceItems.filter(hasUsablePublishedDate).length;
      items.push(...sourceItems);
      if (usableItemCount > 0) {
        sourceResults.push({
          id: source.id,
          name: source.name,
          status: "success",
          itemCount: sourceItems.length,
          usableItemCount,
          errorMessage: "",
          checkedAt,
          category: source.category || "",
          region: source.region || ""
        });
      } else {
        sourceResults.push({
          id: source.id,
          name: source.name,
          status: "other",
          itemCount: sourceItems.length,
          usableItemCount: 0,
          errorMessage: sourceItems.length
            ? `连接成功，但获取的 ${sourceItems.length} 条内容都缺少可用发布时间`
            : "连接成功，但未获取到内容",
          checkedAt,
          category: source.category || "",
          region: source.region || ""
        });
      }
      continue;
    }
    const errorMessage = result.reason?.message ?? "获取失败";
    errors.push(`${source.name}: ${errorMessage}`);
    sourceResults.push({
      id: source.id,
      name: source.name,
      status: classifySourceHealthByError(errorMessage),
      itemCount: 0,
      usableItemCount: 0,
      errorMessage,
      checkedAt,
      category: source.category || "",
      region: source.region || ""
    });
  }

  return {
    items: collectUniqueByKey(items, (item) => `${item.title}|${item.url}`),
    errors,
    sourceResults
  };
}
