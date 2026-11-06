import { readFile } from "node:fs/promises";
import path from "node:path";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { loadSources, loadSettings } from "./config.js";

const PROXY_CONFIG_FILE = path.resolve(process.cwd(), "proxy.local.json");

function withTimeout(timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    done: () => clearTimeout(timeoutId)
  };
}

async function loadProxyConfig() {
  try {
    const raw = await readFile(PROXY_CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { http: "", https: "" };
    }
    return {
      http: String(parsed.http || "").trim(),
      https: String(parsed.https || "").trim()
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { http: "", https: "" };
    }
    throw error;
  }
}

function chooseProxyForUrl(url, proxyConfig) {
  if (url.startsWith("https://")) {
    return proxyConfig.https || proxyConfig.http || "";
  }
  if (url.startsWith("http://")) {
    return proxyConfig.http || proxyConfig.https || "";
  }
  return "";
}

async function testSourceConnection(source, timeoutMs, proxyConfig) {
  const timeout = withTimeout(timeoutMs);
  try {
    const proxyUrl = chooseProxyForUrl(source.url, proxyConfig);
    const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
    const response = await undiciFetch(source.url, {
      method: "GET",
      headers: {
        "User-Agent": "NewsLiveSourceTester/1.0",
        ...source.headers
      },
      dispatcher,
      signal: timeout.signal
    });
    return {
      ok: response.ok,
      statusCode: response.status,
      message: response.ok ? "连接成功" : `HTTP ${response.status}`
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: 0,
      message: error?.message || "连接失败"
    };
  } finally {
    timeout.done();
  }
}

async function main() {
  const settings = await loadSettings();
  const sources = await loadSources();
  const proxyConfig = await loadProxyConfig();
  const timeoutMs = Math.max(5_000, settings.requestTimeoutSeconds * 1000);

  // eslint-disable-next-line no-console
  console.log(`Testing ${sources.length} sources with timeout ${timeoutMs}ms`);
  // eslint-disable-next-line no-console
  console.log(`Proxy config file: ${PROXY_CONFIG_FILE}`);
  // eslint-disable-next-line no-console
  console.log(
    `Proxy in use => http: ${proxyConfig.http || "(none)"} | https: ${proxyConfig.https || "(none)"}`
  );

  for (const source of sources) {
    const result = await testSourceConnection(source, timeoutMs, proxyConfig);
    const icon = result.ok ? "🟢" : result.statusCode ? "🟠" : "🔴";
    // eslint-disable-next-line no-console
    console.log(`${icon} [${source.name}] ${result.message}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error("Source test failed", error);
    process.exit(1);
  });
