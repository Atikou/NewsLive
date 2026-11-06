import assert from "node:assert/strict";
import test from "node:test";
import { translateItemsWithAi } from "../src/ai-translate.js";
import { loadSettings } from "../src/config.js";

function makeConfig(overrides = {}) {
  return {
    enabled: true,
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
