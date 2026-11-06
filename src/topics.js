function uniqueStrings(values) {
  return Array.from(
    new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))
  );
}

export function matchesTopicKeyword(text, keyword) {
  const raw = String(text || "");
  const normalized = String(keyword || "").trim();
  if (!normalized) return false;
  if (/^[A-Za-z0-9_-]+$/.test(normalized)) {
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}([^A-Za-z0-9_-]|$)`, "i").test(raw);
  }
  return raw.toLowerCase().includes(normalized.toLowerCase());
}

function urlMatchesAllowedDomain(url, allowedDomains) {
  let hostname;
  try {
    hostname = new URL(String(url || "")).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }
  return (allowedDomains || []).some((domain) => {
    const normalized = String(domain || "").toLowerCase().replace(/^www\./, "");
    return hostname === normalized || hostname.endsWith(`.${normalized}`);
  });
}

function isTopicAllowedForItem(item, topic) {
  const allowedDomains = topic?.allowedDomains || [];
  if (!allowedDomains.length) return true;
  const urls = [
    item?.url,
    item?.canonicalUrl,
    ...(item?.relatedLinks || []).map((link) => link?.url)
  ];
  return urls.some((url) => urlMatchesAllowedDomain(url, allowedDomains));
}

export function tagItemWithTopics(item, topics) {
  const { matchedPriorityKeywords: _legacyPriorityKeywords, ...topicReadyItem } = item || {};
  const relatedTitles = (item?.relatedLinks || [])
    .flatMap((link) => [link?.title, link?.titleZh])
    .join(" ");
  const searchText = `${item?.title || ""} ${item?.titleZh || ""} ${relatedTitles}`;
  const matches = [];
  for (const topic of topics || []) {
    if (!topic?.enabled || !isTopicAllowedForItem(item, topic)) continue;
    const matchedKeywords = (topic.keywords || []).filter((keyword) =>
      matchesTopicKeyword(searchText, keyword)
    );
    if (!matchedKeywords.length) continue;
    matches.push({ topic, matchedKeywords });
  }
  const matchedTopics = matches.map(({ topic }) => topic.id);
  const matchedTopicNames = matches.map(({ topic }) => topic.name);
  const matchedPushTopics = matches
    .filter(({ topic }) => topic.push)
    .map(({ topic }) => topic.name);
  return {
    ...topicReadyItem,
    matchedTopics,
    matchedTopicNames,
    matchedPushTopics,
    matchedKeywords: uniqueStrings(matches.flatMap(({ matchedKeywords }) => matchedKeywords)),
    isPriority: matchedPushTopics.length > 0
  };
}
