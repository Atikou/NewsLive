import assert from "node:assert/strict";
import test from "node:test";
import { loadTopics } from "../src/config.js";
import { matchesTopicKeyword, tagItemWithTopics } from "../src/topics.js";

test("关注主题配置按主题组织现有关键词", async () => {
  const topics = await loadTopics();
  assert.deepEqual(
    topics.map(({ id, name, enabled, push }) => ({ id, name, enabled, push })),
    [
      { id: "global-affairs", name: "国际局势", enabled: true, push: true },
      { id: "ai-agents", name: "AI 与 Agent", enabled: true, push: true },
      { id: "china-policy", name: "国家政策与民生", enabled: true, push: true }
    ]
  );
  assert.ok(topics[0].keywords.includes("地缘政治"));
  assert.ok(topics[0].keywords.includes("ceasefire"));
  assert.ok(topics[1].keywords.includes("大语言模型"));
  assert.ok(topics[1].keywords.includes("DeepSeek"));
  assert.ok(topics[1].keywords.includes("Kimi"));
  assert.ok(topics[1].keywords.includes("月之暗面"));
  assert.ok(topics[1].keywords.includes("Moonshot AI"));
  assert.ok(topics[1].keywords.includes("Model Context Protocol"));
  assert.ok(topics[2].keywords.includes("国务院常务会议"));
  assert.ok(topics[2].keywords.includes("公开征求意见"));
  assert.ok(topics[2].keywords.includes("社会保障"));
  assert.ok(topics[2].keywords.includes("个人所得税"));
  assert.ok(topics[2].keywords.includes("National People's Congress"));
  assert.ok(topics[2].allowedDomains.includes("gov.cn"));
  assert.ok(topics[2].allowedDomains.includes("chinanews.com.cn"));
  assert.equal(topics[2].keywords.includes("政策"), false);
  assert.equal(topics[2].keywords.includes("补贴"), false);
});

test("英文主题词按完整词匹配，避免 AI 命中 detail", () => {
  assert.equal(matchesTopicKeyword("AI agents are evolving", "AI"), true);
  assert.equal(matchesTopicKeyword("A detailed report", "AI"), false);
});

test("Kimi 品牌别名覆盖产品名与公司名且避免命中人名片段", () => {
  assert.equal(matchesTopicKeyword("Kimi K3 model released", "Kimi"), true);
  assert.equal(matchesTopicKeyword("Kimiko joined the meeting", "Kimi"), false);
  assert.equal(matchesTopicKeyword("月之暗面发布新模型", "月之暗面"), true);
  assert.equal(matchesTopicKeyword("Moonshot AI announces a new model", "Moonshot AI"), true);
});

test("国家政策主题只在限定网站覆盖机关、政策动作和公民权益", async () => {
  const topics = await loadTopics();
  const policyNews = tagItemWithTopics(
    {
      titleZh: "国务院常务会议审议通过育儿补贴实施方案",
      url: "https://www.gov.cn/zhengce/content/example.htm"
    },
    topics
  );
  const livelihoodNews = tagItemWithTopics(
    {
      titleZh: "我国养老金调整方案正式施行",
      url: "https://www.chinanews.com.cn/gn/example.shtml"
    },
    topics
  );
  const personalComment = tagItemWithTopics(
    {
      titleZh: "关于政策选择与补贴设计的一篇个人评论",
      url: "https://www.gov.cn/opinion/example.htm"
    },
    topics
  );
  const foreignLegislation = tagItemWithTopics(
    {
      titleZh: "新西兰立法将英语设为官方语言",
      url: "https://www.theguardian.com/world/example"
    },
    topics
  );
  const foreignCentralBank = tagItemWithTopics(
    {
      titleZh: "印度央行决定维持利率不变",
      url: "https://www.reuters.com/world/example"
    },
    topics
  );
  const copiedPolicy = tagItemWithTopics(
    {
      titleZh: "国务院常务会议审议通过育儿补贴实施方案",
      url: "https://example.com/copied-policy"
    },
    topics
  );

  assert.ok(policyNews.matchedTopics.includes("china-policy"));
  assert.ok(policyNews.matchedPushTopics.includes("国家政策与民生"));
  assert.ok(policyNews.matchedKeywords.includes("国务院常务会议"));
  assert.ok(policyNews.matchedKeywords.includes("育儿补贴"));
  assert.ok(livelihoodNews.matchedTopics.includes("china-policy"));
  assert.ok(livelihoodNews.matchedKeywords.includes("养老金"));
  assert.equal(personalComment.matchedTopics.includes("china-policy"), false);
  assert.equal(foreignLegislation.matchedTopics.includes("china-policy"), false);
  assert.equal(foreignCentralBank.matchedTopics.includes("china-policy"), false);
  assert.equal(copiedPolicy.matchedTopics.includes("china-policy"), false);
});

test("新闻记录主题、实际命中词和推送主题", () => {
  const tagged = tagItemWithTopics(
    {
      title: "New Agent framework released",
      titleZh: "新的智能体框架发布",
      matchedPriorityKeywords: ["旧关键词"]
    },
    [
      {
        id: "ai-agents",
        name: "AI 与 Agent",
        enabled: true,
        push: true,
        keywords: ["AI", "Agent"]
      }
    ]
  );
  assert.deepEqual(tagged.matchedTopics, ["ai-agents"]);
  assert.deepEqual(tagged.matchedTopicNames, ["AI 与 Agent"]);
  assert.deepEqual(tagged.matchedPushTopics, ["AI 与 Agent"]);
  assert.deepEqual(tagged.matchedKeywords, ["Agent"]);
  assert.equal(Object.hasOwn(tagged, "matchedPriorityKeywords"), false);
  assert.equal(tagged.isPriority, true);
});

test("关闭或仅关注不推送的主题不会进入重点队列", () => {
  const tagged = tagItemWithTopics(
    { title: "AI industry update" },
    [
      { id: "disabled", name: "停用主题", enabled: false, push: true, keywords: ["AI"] },
      { id: "read-only", name: "只看不推", enabled: true, push: false, keywords: ["AI"] }
    ]
  );
  assert.deepEqual(tagged.matchedTopics, ["read-only"]);
  assert.deepEqual(tagged.matchedPushTopics, []);
  assert.equal(tagged.isPriority, false);
});
