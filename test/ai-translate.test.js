import assert from "node:assert/strict";
import test from "node:test";
import { translateItemsWithAi } from "../src/ai-translate.js";
import { loadSettings } from "../src/config.js";

function makeConfig(overrides = {}) {
  return {
    enabled: true,
    provider: "deepseek",
    apiFormat: "openai",
    apiUrl: "https://api.deepseek.com",
    apiKey: "test-key",
    model: "deepseek-v4-flash",
    thinkingMode: "disabled",
    anthropicVersion: "2023-06-01",
    maxItemsPerRun: 20,
    batchSize: 8,
    requestTimeoutSeconds: 5,
    onlyNonChinese: true,
    headers: {},
    ...overrides
  };
}

function installFetchMock(t, handler) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

function preserveEnvironment(t, names) {
  const original = new Map(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of original) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });
}

test("Google 默认无需密钥，按标题对应译文并合并分段，复用已有中文", async (t) => {
  const titles = [];
  installFetchMock(t, async (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin + url.pathname, "https://translate.googleapis.com/translate_a/single");
    assert.equal(url.searchParams.get("client"), "gtx");
    assert.equal(url.searchParams.get("sl"), "auto");
    assert.equal(url.searchParams.get("tl"), "zh-CN");
    assert.equal(url.searchParams.get("dt"), "t");
    assert.equal(options.headers, undefined);
    assert.ok(options.signal instanceof AbortSignal);
    const title = url.searchParams.get("q");
    titles.push(title);
    // Reverse completion order to check title/result mapping.
    if (title.startsWith("OpenAI")) await new Promise((resolve) => setImmediate(resolve));
    return Response.json([[[title.startsWith("OpenAI") ? "新模型。" : "第二条。"], ["更多详情。"]]]);
  });
  const items = [
    { title: "OpenAI & AI? #1\nMore details." },
    { title: "Another title" },
    { title: "中文新闻" },
    { title: "Already translated", titleZh: "已有译文" },
    { title: "Over limit" }
  ];
  const result = await translateItemsWithAi(items, makeConfig({
    provider: undefined, apiKey: "", apiUrl: "", model: "", maxItemsPerRun: 2,
    headers: { Authorization: "must-not-leak" }
  }));
  assert.deepEqual(titles, items.slice(0, 2).map((item) => item.title));
  assert.deepEqual(items.map((item) => item.titleZh), ["新模型。更多详情。", "第二条。更多详情。", undefined, "已有译文", undefined]);
  assert.equal(result.translatedCount, 2);
  assert.equal(result.errorMessage, "");
  assert.equal(items[0].title, "OpenAI & AI? #1\nMore details.");
});

test("Google 单条失败不影响其他标题，不自动调用 DeepSeek，遵守批次并发上限", async (t) => {
  let active = 0;
  let maxActive = 0;
  let requests = 0;
  installFetchMock(t, async (input) => {
    const url = new URL(input);
    assert.equal(url.hostname, "translate.googleapis.com");
    requests += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    switch (url.searchParams.get("q")) {
      case "HTTP failure": return new Response("rate limited", { status: 429 });
      case "Malformed": return Response.json({ error: "bad payload" });
      case "Empty": return Response.json([[[" "]]]);
      case "Network failure": throw new TypeError("fetch failed");
      default: return Response.json([[["成功译文"]]]);
    }
  });
  const items = ["HTTP failure", "Success one", "Malformed", "Empty", "Network failure", "Success two"]
    .map((title) => ({ title }));
  const result = await translateItemsWithAi(items, makeConfig({ provider: "google", batchSize: 2 }));
  assert.equal(maxActive, 2);
  assert.equal(requests, 6);
  assert.equal(result.translatedCount, 2);
  assert.match(result.errorMessage, /4 次.*429/);
  assert.deepEqual(items.map((item) => item.titleZh), [undefined, "成功译文", undefined, undefined, undefined, "成功译文"]);
});

test("关闭翻译、未知服务和 DeepSeek 缺少密钥时不发送请求", async (t) => {
  installFetchMock(t, async () => { assert.fail("不应调用接口"); });
  const items = [{ title: "Test title" }];
  const disabled = await translateItemsWithAi(items, makeConfig({ provider: "google", enabled: false }));
  assert.equal(disabled.errorMessage, "");
  const unknown = await translateItemsWithAi(items, makeConfig({ provider: "typo" }));
  assert.match(unknown.errorMessage, /不支持/);
  const missingKey = await translateItemsWithAi(items, makeConfig({ apiKey: "" }));
  assert.match(missingKey.errorMessage, /DEEPSEEK_API_KEY/);
  assert.equal(items[0].titleZh, undefined);
});

test("默认 Google 不受已有 DeepSeek 密钥影响，可通过环境变量切换备选", async (t) => {
  preserveEnvironment(t, ["TRANSLATION_PROVIDER", "DEEPSEEK_API_KEY"]);
  delete process.env.TRANSLATION_PROVIDER;
  process.env.DEEPSEEK_API_KEY = "existing-key";
  assert.equal((await loadSettings()).aiTranslation.provider, "google");
  process.env.TRANSLATION_PROVIDER = " DeepSeek ";
  assert.equal((await loadSettings()).aiTranslation.provider, "deepseek");
});

test("使用 DeepSeek V4 OpenAI 接口翻译并解析 JSON Output", async (t) => {
  let capturedUrl = "";
  let capturedOptions;
  installFetchMock(t, async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: '{"translations":["OpenAI 发布了新模型"]}' } }]
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });

  const items = [{ title: "OpenAI releases a new model" }, { title: "已经是中文标题" }];
  const result = await translateItemsWithAi(items, makeConfig());
  const body = JSON.parse(capturedOptions.body);

  assert.equal(capturedUrl, "https://api.deepseek.com/chat/completions");
  assert.equal(capturedOptions.headers.Authorization, "Bearer test-key");
  assert.equal(capturedOptions.headers["x-api-key"], undefined);
  assert.equal(body.model, "deepseek-v4-flash");
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal(body.stream, false);
  assert.match(body.messages[1].content, /valid JSON/i);
  assert.equal(result.translatedCount, 1);
  assert.equal(result.errorMessage, "");
  assert.equal(items[0].titleZh, "OpenAI 发布了新模型");
  assert.equal(items[1].titleZh, undefined);
});

test("旧 Anthropic 接口格式仍可兼容 V4 模型响应", async (t) => {
  let capturedUrl = "";
  let capturedOptions;
  installFetchMock(t, async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: '{"translations":["测试标题"]}' }]
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });

  const items = [{ title: "Test title" }];
  const result = await translateItemsWithAi(
    items,
    makeConfig({
      apiFormat: "anthropic",
      apiUrl: "https://api.deepseek.com/anthropic"
    })
  );
  const body = JSON.parse(capturedOptions.body);

  assert.equal(capturedUrl, "https://api.deepseek.com/anthropic/v1/messages");
  assert.equal(capturedOptions.headers["x-api-key"], "test-key");
  assert.equal(capturedOptions.headers.Authorization, undefined);
  assert.equal(body.response_format, undefined);
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(result.translatedCount, 1);
  assert.equal(items[0].titleZh, "测试标题");
});

test("已有中文标题时不会重复调用翻译接口", async (t) => {
  let requestCount = 0;
  installFetchMock(t, async () => {
    requestCount += 1;
    throw new Error("不应调用翻译接口");
  });

  const items = [
    {
      title: "OpenAI releases a new model",
      titleZh: "OpenAI 发布了新模型"
    }
  ];
  const result = await translateItemsWithAi(items, makeConfig());

  assert.equal(requestCount, 0);
  assert.equal(result.translatedCount, 0);
  assert.equal(result.errorMessage, "");
  assert.equal(items[0].titleZh, "OpenAI 发布了新模型");
});

test("新 DEEPSEEK 配置优先于旧 ANTHROPIC 配置", async (t) => {
  const names = [
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_API_URL",
    "DEEPSEEK_MODEL",
    "DEEPSEEK_THINKING_MODE",
    "DEEPSEEK_API_FORMAT",
    "AI_API_FORMAT",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_API_URL",
    "ANTHROPIC_MODEL"
  ];
  preserveEnvironment(t, names);
  process.env.DEEPSEEK_API_KEY = "new-key";
  process.env.DEEPSEEK_API_URL = "https://api.deepseek.com";
  process.env.DEEPSEEK_MODEL = "deepseek-v4-pro";
  process.env.DEEPSEEK_THINKING_MODE = "enabled";
  process.env.ANTHROPIC_API_KEY = "legacy-key";
  process.env.ANTHROPIC_API_URL = "https://api.deepseek.com/anthropic/v1/messages";
  process.env.ANTHROPIC_MODEL = "deepseek-chat";
  delete process.env.AI_API_FORMAT;
  delete process.env.DEEPSEEK_API_FORMAT;

  const settings = await loadSettings();

  assert.equal(settings.aiTranslation.apiKey, "new-key");
  assert.equal(settings.aiTranslation.apiUrl, "https://api.deepseek.com");
  assert.equal(settings.aiTranslation.apiFormat, "openai");
  assert.equal(settings.aiTranslation.model, "deepseek-v4-pro");
  assert.equal(settings.aiTranslation.thinkingMode, "enabled");
});

test("旧 DeepSeek 模型名会自动迁移到 V4 Flash", async (t) => {
  const names = [
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_API_URL",
    "DEEPSEEK_MODEL",
    "DEEPSEEK_THINKING_MODE",
    "DEEPSEEK_API_FORMAT",
    "AI_API_FORMAT",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_API_URL",
    "ANTHROPIC_MODEL"
  ];
  preserveEnvironment(t, names);
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_URL;
  delete process.env.DEEPSEEK_MODEL;
  delete process.env.DEEPSEEK_THINKING_MODE;
  delete process.env.DEEPSEEK_API_FORMAT;
  delete process.env.AI_API_FORMAT;
  process.env.ANTHROPIC_API_KEY = "legacy-key";
  process.env.ANTHROPIC_API_URL = "https://api.deepseek.com/anthropic/v1/messages";
  process.env.ANTHROPIC_MODEL = "deepseek-chat";

  const settings = await loadSettings();

  assert.equal(settings.aiTranslation.apiKey, "legacy-key");
  assert.equal(settings.aiTranslation.apiFormat, "anthropic");
  assert.equal(settings.aiTranslation.model, "deepseek-v4-flash");
  assert.equal(settings.aiTranslation.thinkingMode, "disabled");

  process.env.ANTHROPIC_MODEL = "deepseek-reasoner";
  const reasoningSettings = await loadSettings();
  assert.equal(reasoningSettings.aiTranslation.model, "deepseek-v4-flash");
  assert.equal(reasoningSettings.aiTranslation.thinkingMode, "enabled");
});

test("静默时段属于推送配置且不会再暂停获取", async () => {
  const settings = await loadSettings();
  assert.deepEqual(
    settings.push.quietTimeRanges.map((range) => range.text),
    ["23-00 to 07-00"]
  );
  assert.equal("pauseTimeRanges" in settings, false);
  assert.equal(settings.push.maxItemsPerPush, 20);
  assert.equal(settings.push.maxMessageChars, 4096);
  assert.equal(settings.push.deliveryLedgerRetentionDays, 30);
});
