import assert from "node:assert/strict";
import test from "node:test";
import { crawlAllSources } from "../src/sources.js";

function installFetchMock(t, handler) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

function makeSource(overrides = {}) {
  return {
    id: "source",
    name: "测试来源",
    type: "rss",
    url: "https://example.test/feed",
    minTitleLength: 2,
    maxItems: 20,
    headers: {},
    ...overrides
  };
}

test("来源只有在返回可用发布时间时才标记为正常", async (t) => {
  installFetchMock(t, async (url) => {
    if (url === "https://example.test/feed") {
      return new Response(
        `<?xml version="1.0"?><rss><channel><item><title>带时间新闻</title><link>https://example.test/news</link><pubDate>Mon, 03 Aug 2026 01:00:00 GMT</pubDate></item></channel></rss>`,
        { status: 200 }
      );
    }
    return new Response(
      `<html><body><a href="/news">没有发布时间的新闻链接</a></body></html>`,
      { status: 200 }
    );
  });

  const { sourceResults } = await crawlAllSources({
    sources: [
      makeSource(),
      makeSource({
        id: "html-source",
        name: "网页来源",
        type: "html_links",
        url: "https://example.test/page",
        linkSelector: "a"
      })
    ],
    requestTimeoutMs: 1_000
  });

  assert.deepEqual(
    sourceResults.map(({ status, itemCount, usableItemCount }) => ({
      status,
      itemCount,
      usableItemCount
    })),
    [
      { status: "success", itemCount: 1, usableItemCount: 1 },
      { status: "other", itemCount: 1, usableItemCount: 0 }
    ]
  );
  assert.match(sourceResults[1].errorMessage, /缺少可用发布时间/);
});

test("短暂网络失败会自动重试一次", async (t) => {
  let requestCount = 0;
  installFetchMock(t, async () => {
    requestCount += 1;
    if (requestCount === 1) throw new TypeError("fetch failed");
    return new Response(
      `<?xml version="1.0"?><rss><channel><item><title>重试成功新闻</title><link>https://example.test/retry</link><pubDate>Mon, 03 Aug 2026 01:00:00 GMT</pubDate></item></channel></rss>`,
      { status: 200 }
    );
  });

  const result = await crawlAllSources({
    sources: [makeSource()],
    requestTimeoutMs: 1_000
  });

  assert.equal(requestCount, 2);
  assert.equal(result.errors.length, 0);
  assert.equal(result.sourceResults[0].status, "success");
});

test("来源分类、地区和语言会进入新闻条目", async (t) => {
  installFetchMock(t, async () =>
    new Response(
      `<?xml version="1.0"?><rss><channel><item><title>国内财经新闻</title><link>https://example.test/finance</link><pubDate>Mon, 03 Aug 2026 01:00:00 GMT</pubDate></item></channel></rss>`,
      { status: 200 }
    )
  );
  const result = await crawlAllSources({
    sources: [makeSource({ category: "财经", region: "中国", language: "zh-CN" })],
    requestTimeoutMs: 1_000
  });
  assert.equal(result.items[0].category, "财经");
  assert.equal(result.items[0].region, "中国");
  assert.equal(result.items[0].language, "zh-CN");
  assert.equal(result.sourceResults[0].category, "财经");
});
