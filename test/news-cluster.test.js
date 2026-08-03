import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeNewsUrl,
  clusterNewsItems,
  getTitleSimilarity,
  repairNewsClusters
} from "../src/news-cluster.js";

test("新闻 URL 归一化会移除跟踪参数并稳定查询顺序", () => {
  assert.equal(
    canonicalizeNewsUrl("https://www.Example.com/news/?utm_source=x&b=2&a=1#section"),
    "https://example.com/news?a=1&b=2"
  );
});

test("相同链接的不同标题会合并为一个多来源事件", () => {
  const events = clusterNewsItems([
    {
      id: "a",
      title: "OpenAI launches a new agent platform - Example",
      titleZh: "OpenAI 发布新的智能体平台",
      url: "https://example.com/story?utm_source=rss",
      source: "Source A",
      matchedKeywords: ["AI"],
      matchedTopics: ["ai-agents"],
      matchedTopicNames: ["AI 与 Agent"],
      matchedPushTopics: ["AI 与 Agent"]
    },
    {
      id: "b",
      title: "OpenAI launches its new agent platform",
      titleZh: "OpenAI推出全新的智能体平台",
      url: "https://example.com/story",
      source: "Source B",
      matchedKeywords: ["Agent"],
      matchedTopics: ["ai-agents"],
      matchedTopicNames: ["AI 与 Agent"],
      matchedPushTopics: ["AI 与 Agent"]
    }
  ]);

  assert.equal(events.length, 1);
  assert.equal(events[0].clusterSize, 2);
  assert.equal(events[0].sourceCount, 2);
  assert.deepEqual(events[0].relatedSources, ["Source A", "Source B"]);
  assert.deepEqual(events[0].matchedPushTopics, ["AI 与 Agent"]);
  assert.equal(events[0].relatedLinks.length, 1);
});

test("高度相似标题即使链接不同也会聚合", () => {
  assert.ok(
    getTitleSimilarity(
      "特朗普取消对伊朗的空袭，谈判即将恢复",
      "特朗普取消伊朗空袭后，双方谈判即将恢复"
    ) >= 0.7
  );
  const events = clusterNewsItems(
    [
      { titleZh: "央行宣布下调基准利率以支持经济增长", url: "https://a.test/1", source: "A" },
      { titleZh: "央行宣布下调基准利率，以支持经济增长", url: "https://b.test/2", source: "B" }
    ],
    { similarityThreshold: 0.85 }
  );
  assert.equal(events.length, 1);
});

test("字母种类相近但内容无关的英文标题不会误聚合", () => {
  const first = "News live: Australian company saddened by a fatal helicopter collision";
  const second = "Ceuta grapples with aftermath of border surge after migrants leave";
  assert.ok(getTitleSimilarity(first, second) < 0.5);
  assert.equal(
    clusterNewsItems([
      { title: first, url: "https://example.com/one", source: "A" },
      { title: second, url: "https://example.com/two", source: "B" }
    ]).length,
    2
  );
});

test("旧版本误合并的无关来源会被自动拆分", () => {
  const repaired = repairNewsClusters([
    {
      id: "old-id",
      eventId: "old-event",
      title: "News live: Australian company saddened by a fatal helicopter collision",
      titleZh: "澳大利亚公司对直升机事故表示悲痛",
      url: "https://example.com/one",
      source: "A",
      relatedSources: ["A", "B"],
      relatedLinks: [
        {
          title: "News live: Australian company saddened by a fatal helicopter collision",
          titleZh: "澳大利亚公司对直升机事故表示悲痛",
          url: "https://example.com/one",
          source: "A"
        },
        {
          title: "Ceuta grapples with aftermath of border surge after migrants leave",
          titleZh: "休达应对边境移民涌入的后续影响",
          url: "https://example.com/two",
          source: "B"
        }
      ]
    }
  ]);
  assert.equal(repaired.length, 2);
  assert.ok(repaired.some((item) => item.eventId === "old-event"));
});

test("同时连接两个事件簇的新证据会完成并集合并", () => {
  const events = clusterNewsItems([
    { titleZh: "央行宣布下调基准利率", url: "https://a.test/story", source: "A" },
    { titleZh: "市场今日出现重大变化", url: "https://b.test/story", source: "B" },
    { titleZh: "央行宣布下调基准利率", url: "https://b.test/story", source: "C" }
  ]);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].relatedSources, ["A", "B", "C"]);
});

test("既有事件 ID 在后续合并时保持稳定", () => {
  const [existing] = clusterNewsItems([
    { titleZh: "同一事件的中文标题", url: "https://example.com/a", source: "A" }
  ]);
  const [updated] = clusterNewsItems([
    existing,
    { titleZh: "同一事件的中文标题", url: "https://example.com/b", source: "B" }
  ]);
  assert.equal(updated.eventId, existing.eventId);
  assert.equal(updated.sourceCount, 2);
});
