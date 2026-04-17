function withTimeout(timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    done: () => clearTimeout(timeoutId)
  };
}

function containsChinese(text) {
  return /[\u3400-\u9FFF]/.test(String(text || ""));
}

function shouldTranslateTitle(title, onlyNonChinese) {
  const text = String(title || "").trim();
  if (!text) return false;
  if (onlyNonChinese && containsChinese(text)) {
    return false;
  }
  return /[A-Za-z]/.test(text);
}

function extractJsonObject(text) {
  const content = String(text || "").trim();
  if (!content) {
    return null;
  }
  try {
    return JSON.parse(content);
  } catch {
    // Try to recover from model outputs with extra text.
  }
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) {
    return null;
  }
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

async function translateBatch(batch, config) {
  const prompt = [
    "Translate the following news titles into Simplified Chinese.",
    "Keep names, products and institutions accurate.",
    "Return ONLY valid JSON with this shape:",
    '{"translations":["..."]}',
    `The translations array must contain exactly ${batch.length} items in the same order.`,
    "",
    ...batch.map((item, index) => `${index + 1}. ${item.title}`)
  ].join("\n");

  const timeout = withTimeout(Math.max(config.requestTimeoutSeconds * 1000, 5_000));
  try {
    const response = await fetch(config.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": config.anthropicVersion,
        ...config.headers
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 800,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: prompt
          }
        ]
      }),
      signal: timeout.signal
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`翻译接口请求失败 (${response.status}): ${body.slice(0, 200)}`);
    }

    const payload = await response.json();
    const modelText = (payload.content || [])
      .filter((part) => part && part.type === "text")
      .map((part) => part.text || "")
      .join("\n")
      .trim();

    const parsed = extractJsonObject(modelText);
    const translations = parsed && Array.isArray(parsed.translations) ? parsed.translations : null;
    if (!translations || translations.length !== batch.length) {
      throw new Error("翻译结果格式不正确");
    }
    return translations.map((value) => String(value || "").trim());
  } finally {
    timeout.done();
  }
}

export async function translateItemsWithAnthropic(items, config) {
  if (!config || !config.enabled) {
    return { items, translatedCount: 0, errorMessage: "" };
  }
  if (!config.apiUrl || !config.model) {
    return { items, translatedCount: 0, errorMessage: "AI 翻译已启用，但未配置 api_url 或 model" };
  }
  if (!config.apiKey) {
    return { items, translatedCount: 0, errorMessage: "AI 翻译已启用，但未配置 ANTHROPIC_API_KEY" };
  }

  const candidates = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => shouldTranslateTitle(item.title, config.onlyNonChinese))
    .slice(0, config.maxItemsPerRun);

  if (!candidates.length) {
    return { items, translatedCount: 0, errorMessage: "" };
  }

  let translatedCount = 0;
  const batchErrors = [];
  for (let start = 0; start < candidates.length; start += config.batchSize) {
    const batch = candidates.slice(start, start + config.batchSize).map(({ item }) => item);
    try {
      const translated = await translateBatch(batch, config);
      for (let i = 0; i < translated.length; i += 1) {
        const target = candidates[start + i].item;
        const titleZh = translated[i];
        if (!titleZh) continue;
        target.titleZh = titleZh;
        translatedCount += 1;
      }
    } catch (error) {
      batchErrors.push(error?.message || "unknown");
    }
  }

  const errorMessage = batchErrors.length
    ? `AI 翻译部分失败（${batchErrors.length} 批）：${batchErrors[0]}`
    : "";
  return { items, translatedCount, errorMessage };
}
