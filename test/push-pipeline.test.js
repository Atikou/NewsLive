import assert from "node:assert/strict";
import test from "node:test";
import { buildPushMessage, deliverQueuedPushes } from "../src/push-service.js";
import {
  getPendingChannelItems,
  mergePushQueue,
  pruneDeliveryLedger,
  recordChannelResult,
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
