import assert from "node:assert/strict";
import test from "node:test";
import { buildPushMessage, deliverMarkdownMessage, deliverQueuedPushes } from "../src/push-service.js";
import {
  getPendingChannelItems,
  mergePushQueue,
  pruneDeliveryLedger,
  recordChannelResult,
  retainTodayPushQueue,
  removeFullyDeliveredItems
} from "../src/push-store.js";

function event(overrides = {}) {
  return {
    eventId: "event-1",
    id: "source-item-1",
    titleZh: "一条重点新闻",
    url: "https://example.com/news",
    source: "来源 A",
    relatedSources: ["来源 A", "来源 B"],
    matchedPushTopics: ["AI 与 Agent"],
    ...overrides
  };
}

const barkSettings = {
  push: {
    enabled: true, dayAppPushUrl: "https://api.day.app/key/", ntfyPushUrl: "",
    maxItemsPerPush: 20, maxMessageChars: 4096
  }
};

test("待推送队列按业务时区只保留当天新闻，跨日旧闻不再补发", () => {
  const queue = mergePushQueue({ items: [] }, [
    event({ eventId: "yesterday", pubDate: "2026-11-08T15:59:59Z" }),
    event({ eventId: "today", pubDate: "2026-11-08T16:00:00Z" }),
    event({ eventId: "tomorrow", pubDate: "2026-11-09T16:00:00Z" }),
    event({ eventId: "invalid", pubDate: "invalid" }),
    event({ eventId: "legacy", fetchedAt: "2026-11-09T00:00:00Z" })
  ]);
  const kept = retainTodayPushQueue(queue, new Date("2026-11-09T02:00:00Z"), "Asia/Shanghai");
  assert.deepEqual(kept.items.map((item) => item.eventId), ["today", "legacy"]);
  assert.equal(queue.items.length, 5);
});

function apnsBytes(payload) {
  const { title, body, group, markdown } = payload;
  const serialized = JSON.stringify({
    aps: {
      alert: { title, subtitle: "", body }, sound: "1107",
      category: "myNotificationCategory", "mutable-content": 1, "thread-id": group
    }, group, markdown
  }).replace(/[<>&\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return Buffer.byteLength(serialized);
}

test("Bark 按完整 APNs 包拆分，中文超链接完整且成功事件不重复投递", async () => {
  const items = Array.from({ length: 20 }, (_, index) => event({
    eventId: `bark-${index}`, titleZh: `新闻 ${index}：` + '中文😀<&"'.repeat(10),
    url: `https://example.com/${index}?q=${"a".repeat(120)}`, targetChannels: ["dayApp"]
  }));
  const oldBatch = buildPushMessage(items);
  assert.ok(apnsBytes({
    title: "NewsLive 重点新闻", group: "NewsLive", markdown: oldBatch.message,
    body: buildPushMessage(oldBatch.usedItems, 4096, { markdown: false }).message
  }) > 4096, "样本应复现仅计算 Markdown 导致的超限");

  const deliveredLinks = [];
  let calls = 0;
  const fetchImpl = async (_, options) => {
    const payload = JSON.parse(options.body);
    assert.ok(apnsBytes(payload) <= 4096);
    calls += 1;
    if (calls === 2) return { ok: false, status: 500, json: async () => ({ message: "ServiceUnavailable" }) };
    deliveredLinks.push(...[...payload.markdown.matchAll(/\]\((https:[^)]+)\)/g)].map((match) => match[1]));
    return { ok: true, status: 200 };
  };
  const first = await deliverQueuedPushes({
    queue: mergePushQueue({ items: [] }, items), ledger: {}, settings: barkSettings, fetchImpl
  });
  assert.ok(first.delivered.length > 0);
  assert.ok(first.queue.items.length > 0);
  assert.match(first.errors[0], /ServiceUnavailable/);
  const second = await deliverQueuedPushes({
    queue: first.queue, ledger: first.ledger, settings: barkSettings, fetchImpl
  });
  assert.equal(second.queue.items.length, 0);
  assert.deepEqual(deliveredLinks, items.map((item) => item.url));
});

test("Bark 单条过长不会截断超链接或误记成功", async () => {
  let calls = 0;
  const result = await deliverQueuedPushes({
    queue: mergePushQueue({ items: [] }, [event({ url: `https://example.com/${"x".repeat(5000)}` })]),
    ledger: {}, settings: barkSettings,
    fetchImpl: async () => { calls += 1; return { ok: true }; }
  });
  assert.equal(calls, 0);
  assert.equal(result.queue.items.length, 1);
  assert.equal(result.ledger.events["event-1"].channels.dayApp.status, "failed");
  assert.match(result.errors[0], /4096-byte/);
});

test("ntfy 按 UTF-8 4096 字节硬上限拆包，配置增大也不能变成附件", async () => {
  const items = Array.from({ length: 20 }, (_, index) => event({
    eventId: `ntfy-${index}`, titleZh: `新闻 ${index}：${"中文😀".repeat(40)}`,
    url: `https://example.com/${index}`, targetChannels: ["ntfy"]
  }));
  const messages = [];
  const result = await deliverQueuedPushes({
    queue: mergePushQueue({ items: [] }, items), ledger: {},
    settings: { push: { ...barkSettings.push, dayAppPushUrl: "", ntfyPushUrl: "https://ntfy.sh/topic", maxMessageChars: 10000 } },
    fetchImpl: async (_, options) => {
      assert.ok(Buffer.byteLength(options.body) <= 4096);
      messages.push(options.body);
      return { ok: true };
    }
  });
  assert.ok(messages.length > 1);
  assert.equal(result.queue.items.length, 0);
  assert.deepEqual([...messages.join("\n").matchAll(/\]\((https:[^)]+)\)/g)].map((match) => match[1]), items.map((item) => item.url));
});

test("单条超限保留失败且不阻塞后续正常新闻，两渠道都不截断链接", async () => {
  for (const channel of ["dayApp", "ntfy"]) {
    let calls = 0;
    const result = await deliverQueuedPushes({
      queue: mergePushQueue({ items: [] }, [
        event({ eventId: "oversize", url: `https://example.com/${"x".repeat(5000)}`, targetChannels: [channel] }),
        event({ eventId: "normal", targetChannels: [channel] })
      ]), ledger: {},
      settings: { push: { ...barkSettings.push, ntfyPushUrl: "https://ntfy.sh/topic" } },
      fetchImpl: async () => { calls += 1; return { ok: true }; }
    });
    assert.equal(calls, 1);
    assert.deepEqual(result.queue.items.map((item) => item.eventId), ["oversize"]);
    assert.equal(result.ledger.events.normal.channels[channel].status, "delivered");
    assert.equal(result.ledger.events.oversize.channels[channel].status, "failed");
  }
});

test("ntfy 热榜和其他独立消息同样检查正文及标题大小", async () => {
  const settings = { push: { ...barkSettings.push, dayAppPushUrl: "", ntfyPushUrl: "https://ntfy.sh/topic" } };
  for (const message of [
    { title: "国内热榜", markdown: "中".repeat(1366), expected: /4096-byte/ },
    { title: "中".repeat(342), markdown: "正文", expected: /1024-byte/ }
  ]) {
    const result = await deliverMarkdownMessage({
      ...message, settings, fetchImpl: async () => assert.fail("超限消息不应发出")
    });
    assert.match(result.errors[0], message.expected);
    assert.deepEqual(result.delivered, []);
  }
  let calls = 0;
  const boundary = await deliverMarkdownMessage({
    title: "a".repeat(1024), markdown: "a".repeat(4096), settings,
    fetchImpl: async () => { calls += 1; return { ok: true }; }
  });
  assert.equal(calls, 1);
  assert.deepEqual(boundary.delivered, ["ntfy"]);
});

test("Bark 记录 APNs 错误类型但不公开响应中的设备密钥", async () => {
  const result = await deliverMarkdownMessage({
    title: "测试", markdown: "[中文标题](https://example.com/)", settings: barkSettings,
    fetchImpl: async () => ({
      ok: false, status: 500,
      json: async () => ({ message: "push failed: APNS PayloadTooLarge device_key=private-key" })
    })
  });
  assert.deepEqual(result.errors, ["day.app push failed (500): PayloadTooLarge"]);
  assert.deepEqual(result.delivered, []);
});

test("Bark 热榜共用完整包大小检查，失败仍保留重试状态", async () => {
  const result = await deliverMarkdownMessage({
    title: "国内热榜", markdown: "热榜".repeat(500), plain: "热榜".repeat(500),
    settings: barkSettings, fetchImpl: async () => assert.fail("超限消息不应发出")
  });
  assert.match(result.errors[0], /4096-byte/);
  assert.deepEqual(result.delivered, []);
});

test("多标签事件进入队列时只保留一份", () => {
  const queue = mergePushQueue({ items: [] }, [event(), event()]);
  assert.equal(queue.items.length, 1);
  assert.deepEqual(queue.items[0].matchedPushTopics, ["AI 与 Agent"]);
});

test("事件只投递到入队时记录的目标渠道", () => {
  const queue = mergePushQueue(
    { items: [] },
    [event({ targetChannels: ["dayApp"] })]
  );
  assert.equal(getPendingChannelItems(queue, {}, "dayApp").length, 1);
  assert.equal(getPendingChannelItems(queue, {}, "ntfy").length, 0);
});

test("仅当所有启用渠道都成功后才从队列移除", () => {
  const queue = mergePushQueue({ items: [] }, [event()]);
  let ledger = recordChannelResult({}, "dayApp", queue.items, { ok: true }, "2026-08-03T01:00:00Z");
  assert.equal(removeFullyDeliveredItems(queue, ledger, ["dayApp", "ntfy"]).items.length, 1);
  ledger = recordChannelResult(ledger, "ntfy", queue.items, { ok: true }, "2026-08-03T01:01:00Z");
  assert.equal(removeFullyDeliveredItems(queue, ledger, ["dayApp", "ntfy"]).items.length, 0);
});

test("账本清理不会删除仍在待发送队列中的渠道进度", () => {
  const queue = mergePushQueue({ items: [] }, [event({ targetChannels: ["dayApp", "ntfy"] })]);
  const ledger = recordChannelResult(
    {},
    "dayApp",
    queue.items,
    { ok: true },
    "2026-01-01T00:00:00Z"
  );
  const pruned = pruneDeliveryLedger(
    ledger,
    1,
    new Date("2026-08-03T00:00:00Z"),
    queue.items.map((item) => item.eventId)
  );
  assert.equal(pruned.events["event-1"].channels.dayApp.status, "delivered");
});

test("推送正文使用来源在前、标题超链接在后的紧凑格式", () => {
  const built = buildPushMessage(
    [event({ pubDate: "2026-08-03T03:06:12Z" })],
    4096,
    { timeZone: "Asia/Shanghai" }
  );
  assert.match(
    built.message,
    /^1\. \[来源 A 等 2 个来源\] \[一条重点新闻\]\(https:\/\/example\.com\/news\)/
  );
  assert.match(built.message, /08-03 11:06/);
  assert.match(built.message, /#AI 与 Agent/);
  assert.doesNotMatch(built.message, /2026-08-03T03:06:12Z/);
});

test("Bark 和 ntfy 只在 Markdown 标题中保留正文链接", async () => {
  const calls = [];
  const settings = {
    timezone: "Asia/Shanghai",
    push: {
      enabled: true,
      dayAppPushUrl: "https://api.day.app/key/",
      ntfyPushUrl: "https://ntfy.sh/topic",
      maxItemsPerPush: 15,
      maxMessageChars: 4096
    }
  };
  const result = await deliverQueuedPushes({
    queue: mergePushQueue(
      { items: [] },
      [event({ targetChannels: ["dayApp", "ntfy"], pubDate: "2026-08-03T03:06:12Z" })]
    ),
    ledger: {},
    settings,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return { ok: true, status: 200 };
    }
  });
  const bark = calls.find((call) => call.url.includes("api.day.app"));
  const ntfy = calls.find((call) => call.url.includes("ntfy.sh"));
  const barkPayload = JSON.parse(bark.options.body);

  assert.equal(result.queue.items.length, 0);
  assert.equal(bark.options.method, "POST");
  assert.match(bark.options.headers["Content-Type"], /application\/json/);
  assert.match(barkPayload.markdown, /\[一条重点新闻\]\(https:\/\/example\.com\/news\)/);
  assert.doesNotMatch(barkPayload.body, /https:\/\//);
  assert.equal(barkPayload.url, undefined);
  assert.match(ntfy.options.body, /\[一条重点新闻\]\(https:\/\/example\.com\/news\)/);
  assert.equal(ntfy.options.headers.Click, undefined);
  assert.equal(ntfy.options.headers.Markdown, "yes");
});

test("短标题单条推送最多容纳 20 条并继续按条数拆包", async () => {
  const calls = [];
  const items = Array.from({ length: 24 }, (_, index) =>
    event({
      eventId: `event-${index + 1}`,
      id: `source-item-${index + 1}`,
      titleZh: `重点新闻 ${index + 1}`,
      url: `https://example.com/news/${index + 1}`,
      targetChannels: ["ntfy"]
    })
  );
  const settings = {
    push: {
      enabled: true,
      dayAppPushUrl: "",
      ntfyPushUrl: "https://ntfy.sh/topic",
      maxItemsPerPush: 20,
      maxMessageChars: 4096
    }
  };
  const result = await deliverQueuedPushes({
    queue: mergePushQueue({ items: [] }, items),
    ledger: {},
    settings,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return { ok: true, status: 200 };
    }
  });

  assert.equal(result.queue.items.length, 0);
  assert.equal(calls.length, 2);
  assert.match(calls[0].options.body, /^1\./);
  assert.match(calls[0].options.body, /\n20\./);
  assert.match(calls[1].options.body, /^1\./);
  assert.match(calls[1].options.body, /\n4\./);
});

test("分渠道失败不会把其他渠道的成功状态抹掉", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), method: options.method });
    return { ok: String(url).includes("api.day.app"), status: 503 };
  };
  const settings = {
    push: {
      enabled: true,
      dayAppPushUrl: "https://api.day.app/key/",
      ntfyPushUrl: "https://ntfy.sh/topic",
      maxItemsPerPush: 15,
      maxMessageChars: 4096
    }
  };
  const first = await deliverQueuedPushes({
    queue: mergePushQueue({ items: [] }, [event()]),
    ledger: {},
    settings,
    fetchImpl,
    now: new Date("2026-08-03T01:00:00Z")
  });
  assert.equal(first.queue.items.length, 1);
  assert.equal(first.ledger.events["event-1"].channels.dayApp.status, "delivered");
  assert.equal(first.ledger.events["event-1"].channels.ntfy.status, "failed");
  assert.equal(first.errors.length, 1);

  const second = await deliverQueuedPushes({
    queue: first.queue,
    ledger: first.ledger,
    settings,
    fetchImpl,
    now: new Date("2026-08-03T01:05:00Z")
  });
  assert.equal(getPendingChannelItems(second.queue, second.ledger, "dayApp").length, 0);
  assert.deepEqual(calls.map((call) => call.method), ["POST", "POST", "POST"]);
});
