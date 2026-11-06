import assert from "node:assert/strict";
import test from "node:test";
import { loadSettings } from "../src/config.js";
import {
  buildRankingPushMessage,
  createEmptyRankings,
  getDueRankingPushSlot,
  maybePushRankings,
  refreshRankings
} from "../src/rankings.js";

function apiPayload(id) {
  const itemById = {
    weibo: { title: "微博测试话题", url: "https://s.weibo.com/weibo?q=test" },
    douyin: { title: "抖音测试话题", url: "https://www.douyin.com/hot/1" },
    "bilibili-hot-search": {
      title: "B站测试话题",
      url: "https://search.bilibili.com/all?keyword=test"
    }
  };
  return { status: "cache", items: [itemById[id]] };
}

test("榜单配置保持轻量的每日两次推送默认值", async () => {
  const settings = await loadSettings();
  assert.equal(settings.rankings.enabled, true);
  assert.deepEqual(settings.rankings.push.times, ["12:00", "20:00"]);
  assert.equal(settings.rankings.push.itemsPerPlatform, 3);
});

test("三平台榜单映射排名变化并校验目标域名", async () => {
  const previous = {
    ...createEmptyRankings(),
    platforms: {
      weibo: {
        items: [{ title: "微博测试话题", url: "https://s.weibo.com/weibo?q=test", rank: 4 }]
      },
      douyin: {
        items: [{ title: "旧抖音话题", url: "https://www.douyin.com/hot/old", rank: 1 }]
      }
    }
  };
  const snapshot = await refreshRankings(
    previous,
    {
      enabled: true,
      apiUrl: "https://newsnow.test/api/s",
      maxItemsPerPlatform: 30,
      requestTimeoutMs: 1_000
    },
    {
      now: new Date("2026-08-03T04:00:00Z"),
      fetchImpl: async (url) => {
        const id = new URL(url).searchParams.get("id");
        const payload = apiPayload(id);
        if (id === "douyin") payload.items[0].url = "https://malicious.example/phishing";
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
    }
  );

  assert.equal(snapshot.platforms.weibo.items[0].previousRank, 4);
  assert.equal(snapshot.platforms.weibo.items[0].rankChange, 3);
  assert.equal(snapshot.platforms.douyin.status, "failed");
  assert.equal(snapshot.platforms.douyin.stale, true);
  assert.equal(snapshot.platforms.douyin.items[0].title, "旧抖音话题");
  assert.equal(snapshot.platforms.bilibili.status, "success");
});

test("榜单只在计划时段后的窗口内判定为待推送", () => {
  const rankings = {
    push: { enabled: true, times: ["12:00", "20:00"], windowMinutes: 90 }
  };
  assert.equal(
    getDueRankingPushSlot(new Date("2026-08-03T04:30:00Z"), rankings, "Asia/Shanghai").key,
    "2026-08-03@12:00"
  );
  assert.equal(
    getDueRankingPushSlot(new Date("2026-08-03T07:30:00Z"), rankings, "Asia/Shanghai"),
    null
  );
  assert.equal(
    getDueRankingPushSlot(new Date("2026-08-03T12:30:00Z"), rankings, "Asia/Shanghai").key,
    "2026-08-03@20:00"
  );
});

test("榜单推送保持来源标签在前、标题超链接在后的格式", () => {
  const snapshot = {
    platforms: {
      weibo: {
        status: "success",
        items: [{ title: "测试热点", url: "https://s.weibo.com/weibo?q=test", rank: 1 }]
      }
    }
  };
  const message = buildRankingPushMessage(snapshot, 3, "12:00");
  assert.match(message.markdown, /1\. \[微博\] \[测试热点\]\(https:\/\/s\.weibo\.com\/weibo\?q=test\)/);
  assert.doesNotMatch(message.plain, /https:\/\//);
});

test("榜单推送按渠道记账，重试时不会重复发送成功渠道", async () => {
  const snapshot = {
    ...createEmptyRankings(),
    platforms: {
      weibo: {
        status: "success",
        items: [{ title: "测试热点", url: "https://s.weibo.com/weibo?q=test", rank: 1 }]
      }
    }
  };
  const settings = {
    timezone: "Asia/Shanghai",
    push: {
      enabled: true,
      dayAppPushUrl: "https://api.day.app/key/",
      ntfyPushUrl: "https://ntfy.sh/topic"
    },
    rankings: {
      enabled: true,
      push: { enabled: true, times: ["12:00", "20:00"], itemsPerPlatform: 3, windowMinutes: 90 }
    }
  };
  const calls = [];
  const first = await maybePushRankings(snapshot, settings, {
    now: new Date("2026-08-03T04:30:00Z"),
    fetchImpl: async (url) => {
      calls.push(String(url));
      return { ok: String(url).includes("api.day.app"), status: 503 };
    }
  });
  assert.equal(first.snapshot.pushSlots["2026-08-03@12:00"].channels.dayApp.status, "delivered");
  assert.equal(first.snapshot.pushSlots["2026-08-03@12:00"].channels.ntfy.status, "failed");

  const retryCalls = [];
  const second = await maybePushRankings(first.snapshot, settings, {
    now: new Date("2026-08-03T04:40:00Z"),
    fetchImpl: async (url) => {
      retryCalls.push(String(url));
      return { ok: true, status: 200 };
    }
  });
  assert.deepEqual(retryCalls, ["https://ntfy.sh/topic"]);
  assert.equal(second.snapshot.pushSlots["2026-08-03@12:00"].channels.ntfy.status, "delivered");
  assert.equal(calls.length, 2);
});
