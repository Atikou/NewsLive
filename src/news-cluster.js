import crypto from "node:crypto";

const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "oc",
  "ref",
  "source"
]);

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const normalized = String(value || "").trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function displayTitle(item) {
  return String(item?.titleZh || item?.title || "").trim();
}

export function canonicalizeNewsUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    url.hash = "";
    for (const key of Array.from(url.searchParams.keys())) {
      if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMS.has(key.toLowerCase())) {
        url.searchParams.delete(key);
      }
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    url.pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
    const query = Array.from(url.searchParams.entries()).sort(([a], [b]) => a.localeCompare(b));
    url.search = "";
    for (const [key, val] of query) url.searchParams.append(key, val);
    return url.toString();
  } catch {
    return String(value || "").trim();
  }
}

export function normalizeNewsTitle(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+(?:-|–|—|\|)\s+[^-–—|]{2,40}$/u, "")
    .replace(/[\p{P}\p{S}\s]+/gu, "")
    .trim();
}

function bigrams(value) {
  const normalized = normalizeNewsTitle(value);
  if (normalized.length < 2) return new Set(normalized ? [normalized] : []);
  const result = new Set();
  for (let index = 0; index < normalized.length - 1; index += 1) {
    result.add(normalized.slice(index, index + 2));
  }
  return result;
}

function characters(value) {
  return new Set(Array.from(normalizeNewsTitle(value)));
}

function isMostlyCjk(value) {
  const normalized = normalizeNewsTitle(value);
  if (!normalized) return false;
  const cjkCount = (normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) || [])
    .length;
  return cjkCount / Array.from(normalized).length >= 0.6;
}

function diceSimilarity(left, right) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const part of left) {
    if (right.has(part)) intersection += 1;
  }
  return (2 * intersection) / (left.size + right.size);
}

export function getTitleSimilarity(left, right) {
  const a = normalizeNewsTitle(left);
  const b = normalizeNewsTitle(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (Math.min(a.length, b.length) < 10) return 0;
  const aParts = bigrams(a);
  const bParts = bigrams(b);
  const bigramSimilarity = diceSimilarity(aParts, bParts);
  // 中文标题经常只是调换短语顺序。字符集合分数只作为较低权重的补充，
  // 避免仅因常见字相同就把两个事件误合并。
  const characterSimilarity =
    isMostlyCjk(a) && isMostlyCjk(b)
      ? diceSimilarity(characters(a), characters(b)) * 0.9
      : 0;
  return Math.max(bigramSimilarity, characterSimilarity);
}

function itemCanonicalUrls(item) {
  return uniqueStrings([
    canonicalizeNewsUrl(item?.url),
    item?.canonicalUrl,
    ...(item?.relatedLinks || []).map((link) => canonicalizeNewsUrl(link?.url))
  ]).filter(Boolean);
}

function itemTitles(item) {
  return uniqueStrings([
    item?.titleZh,
    item?.title,
    ...(item?.relatedLinks || []).flatMap((link) => [link?.titleZh, link?.title])
  ]);
}

function clusterMatches(cluster, item, similarityThreshold) {
  if (item?.eventId && cluster.eventIds.has(item.eventId)) return true;
  const urls = itemCanonicalUrls(item);
  if (urls.some((url) => cluster.urls.has(url))) return true;
  const titles = itemTitles(item);
  return titles.some((title) =>
    cluster.titles.some((existing) => getTitleSimilarity(title, existing) >= similarityThreshold)
  );
}

function representativeScore(item) {
  let score = 0;
  if (String(item?.titleZh || "").trim()) score += 8;
  score += Math.min(displayTitle(item).length, 120) / 120;
  score += (item?.matchedPushTopics || []).length * 0.2;
  score += (item?.relatedSources || []).length * 0.05;
  return score;
}

function mergeCluster(cluster) {
  const items = cluster.items;
  const representative = items
    .slice()
    .sort((a, b) => representativeScore(b) - representativeScore(a))[0];
  const relatedLinks = [];
  const linkKeys = new Set();
  const sources = [];

  for (const item of items) {
    sources.push(item?.source, ...(item?.relatedSources || []));
    const links = [
      {
        url: item?.url,
        source: item?.source,
        title: String(item?.title || "").trim(),
        titleZh: String(item?.titleZh || "").trim()
      },
      ...(item?.relatedLinks || [])
    ];
    for (const link of links) {
      const url = canonicalizeNewsUrl(link?.url);
      if (!url || linkKeys.has(url)) continue;
      linkKeys.add(url);
      relatedLinks.push({
        url: String(link?.url || "").trim(),
        source: String(link?.source || "").trim(),
        title: String(link?.title || "").trim(),
        titleZh: String(link?.titleZh || "").trim()
      });
    }
  }

  const relatedSources = uniqueStrings(sources);
  // 聚类会在每轮抓取时重新处理已有事件。使用可验证的来源/链接数量，
  // 可避免 clusterSize 在重复抓取同一批内容时不断累加。
  const clusterSize = Math.max(1, relatedLinks.length, relatedSources.length);
  const matchedKeywords = uniqueStrings(items.flatMap((item) => item?.matchedKeywords || []));
  const matchedTopics = uniqueStrings(items.flatMap((item) => item?.matchedTopics || []));
  const matchedTopicNames = uniqueStrings(
    items.flatMap((item) => item?.matchedTopicNames || [])
  );
  const matchedPushTopics = uniqueStrings(
    items.flatMap((item) => item?.matchedPushTopics || [])
  );
  const categories = uniqueStrings(
    items.flatMap((item) => [item?.category, ...(item?.categories || [])])
  );
  const regions = uniqueStrings(items.flatMap((item) => [item?.region, ...(item?.regions || [])]));
  const languages = uniqueStrings(
    items.flatMap((item) => [item?.language, ...(item?.languages || [])])
  );
  const existingEventId = items.map((item) => item?.eventId).find(Boolean);
  const canonicalUrl = canonicalizeNewsUrl(representative?.url) || cluster.urls.values().next().value || "";
  const eventSeed = canonicalUrl || normalizeNewsTitle(displayTitle(representative));
  const eventId =
    existingEventId || crypto.createHash("sha1").update(`event:${eventSeed}`).digest("hex");

  return {
    ...representative,
    id: representative?.id || eventId,
    eventId,
    canonicalUrl,
    clusterSize,
    sourceCount: relatedSources.length,
    relatedSources,
    relatedLinks,
    category: representative?.category || categories[0] || "",
    categories,
    region: representative?.region || regions[0] || "",
    regions,
    language: representative?.language || languages[0] || "",
    languages,
    matchedKeywords,
    matchedTopics,
    matchedTopicNames,
    matchedPushTopics,
    isPriority: matchedPushTopics.length > 0
  };
}

export function clusterNewsItems(items, { similarityThreshold = 0.88 } = {}) {
  const clusters = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== "object") continue;
    const matches = clusters.filter((candidate) =>
      clusterMatches(candidate, item, similarityThreshold)
    );
    let cluster = matches[0];
    if (!cluster) {
      cluster = {
        items: [],
        urls: new Set(),
        titles: [],
        eventIds: new Set()
      };
      clusters.push(cluster);
    } else if (matches.length > 1) {
      // 新证据可能以“标题匹配 A、链接匹配 B”的方式桥接两个已有簇。
      // 必须真正合并所有命中簇，否则结果会依赖输入顺序并留下重复事件。
      for (const extra of matches.slice(1)) {
        cluster.items.push(...extra.items);
        for (const url of extra.urls) cluster.urls.add(url);
        for (const title of extra.titles) {
          if (!cluster.titles.includes(title)) cluster.titles.push(title);
        }
        for (const eventId of extra.eventIds) cluster.eventIds.add(eventId);
        clusters.splice(clusters.indexOf(extra), 1);
      }
    }
    cluster.items.push(item);
    for (const url of itemCanonicalUrls(item)) cluster.urls.add(url);
    for (const title of itemTitles(item)) {
      if (!cluster.titles.includes(title)) cluster.titles.push(title);
    }
    if (item.eventId) cluster.eventIds.add(item.eventId);
  }
  return clusters.map(mergeCluster);
}

function linkToItem(base, link, isPrimary) {
  const legacyDisplayTitle = String(link?.title || "").trim();
  return {
    ...(isPrimary ? base : {}),
    id: isPrimary ? base.id : "",
    eventId: "",
    title: isPrimary ? base.title : legacyDisplayTitle,
    titleZh: isPrimary ? base.titleZh : String(link?.titleZh || legacyDisplayTitle),
    url: String(link?.url || ""),
    source: String(link?.source || base?.source || ""),
    pubDate: base?.pubDate || "",
    fetchedAt: base?.fetchedAt || "",
    category: base?.category || "",
    categories: base?.categories || [],
    region: base?.region || "",
    regions: base?.regions || [],
    language: base?.language || "",
    languages: base?.languages || [],
    relatedSources: [],
    relatedLinks: [],
    clusterSize: 1,
    sourceCount: 1
  };
}

/**
 * 早期聚类版本可能把字符种类相似的英文标题误合并。这里根据每条来源证据
 * 重新聚类；只有确实需要拆分时才重建事件，正常事件保持原 ID 和元数据。
 */
export function repairNewsClusters(items, options = {}) {
  const repaired = [];
  for (const item of Array.isArray(items) ? items : []) {
    const links = Array.isArray(item?.relatedLinks) ? item.relatedLinks.filter((link) => link?.url) : [];
    if (links.length < 2) {
      repaired.push(item);
      continue;
    }
    const primaryUrl = canonicalizeNewsUrl(item.url);
    const evidence = links.map((link) =>
      linkToItem(item, link, canonicalizeNewsUrl(link.url) === primaryUrl)
    );
    const groups = clusterNewsItems(evidence, options);
    if (groups.length <= 1) {
      repaired.push(item);
      continue;
    }
    for (const group of groups) {
      const containsPrimary = (group.relatedLinks || []).some(
        (link) => canonicalizeNewsUrl(link.url) === primaryUrl
      );
      repaired.push(
        containsPrimary
          ? {
              ...group,
              id: item.id,
              eventId: item.eventId,
              title: item.title,
              titleZh: item.titleZh,
              url: item.url,
              source: item.source,
              canonicalUrl: primaryUrl
            }
          : group
      );
    }
  }
  return repaired;
}
