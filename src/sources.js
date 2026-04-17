import * as cheerio from "cheerio";

function withTimeout(url, timeoutMs, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => {
    clearTimeout(timeoutId);
  });
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

function splitUserAgent(headers = {}) {
  const merged = { ...headers };
  const userAgent = merged["User-Agent"] || merged["user-agent"] || "";
  delete merged["User-Agent"];
  delete merged["user-agent"];
  return {
    userAgent: String(userAgent || "").trim(),
    headers: merged
  };
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
  const response = await withTimeout(finalUrl, timeoutMs, {
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
  const response = await withTimeout(finalUrl, timeoutMs, {
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

async function fetchRenderedHtml(source, timeoutMs) {
  const { chromium } = await import("playwright");
  const { userAgent, headers } = splitUserAgent(source.headers);
  let browser;
  let launchError;
  for (const launchOptions of [{}, { channel: "msedge" }, { channel: "chrome" }]) {
    try {
      browser = await chromium.launch({ headless: true, ...launchOptions });
      break;
    } catch (error) {
      launchError = error;
    }
  }
  if (!browser) {
    throw launchError || new Error("无法启动无头浏览器");
  }
  const context = await browser.newContext({
    userAgent: userAgent || undefined,
    extraHTTPHeaders: headers
  });

  try {
    const page = await context.newPage();
    await page.goto(source.url, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs
    });
    if (source.waitForSelector) {
      await page.waitForSelector(source.waitForSelector, {
        timeout: Math.min(source.browserWaitMs, timeoutMs)
      });
    } else {
      await page.waitForTimeout(Math.min(source.browserWaitMs, timeoutMs));
    }
    const html = await page.content();
    return html;
  } finally {
    await context.close();
    await browser.close();
  }
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
          title: `无法抓取页面: ${link}`,
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
  if (source.type === "browser_html_links") {
    const html = await fetchRenderedHtml(source, timeoutMs);
    return extractHtmlLinks(html, source);
  }
  if (source.type === "json_items") {
    return crawlJsonItems(source, timeoutMs);
  }
  if (source.type === "markdown_link_pages") {
    return crawlMarkdownLinkedPages(source, timeoutMs);
  }
  throw new Error(`不支持的来源类型: ${source.type} (${source.id})`);
}

export async function crawlAllSources({ sources, requestTimeoutMs }) {
  const results = await Promise.allSettled(
    sources.map((source) => crawlSingleSource(source, requestTimeoutMs))
  );
  const items = [];
  const errors = [];

  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    const source = sources[index];
    if (result.status === "fulfilled") {
      items.push(...result.value);
      continue;
    }
    errors.push(`${source.name}: ${result.reason?.message ?? "抓取失败"}`);
  }

  return {
    items: collectUniqueByKey(items, (item) => `${item.title}|${item.url}`),
    errors
  };
}
