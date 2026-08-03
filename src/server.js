import crypto from "node:crypto";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NewsCrawler } from "./crawler.js";
import { loadNewsArchive } from "./persistence.js";
import { loadRankings } from "./rankings.js";
import { renderRankingsPage } from "./rankings-page.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, "../public");
const PORT = Number(process.env.PORT || 5178);
const HOST = String(process.env.HOST || "127.0.0.1").trim();
const ADMIN_TOKEN = String(process.env.NEWSLIVE_ADMIN_TOKEN || "").trim();

function isLoopbackHost(host) {
  return ["127.0.0.1", "::1", "localhost"].includes(String(host || "").toLowerCase());
}

function tokenMatches(value) {
  const provided = Buffer.from(String(value || ""));
  const expected = Buffer.from(ADMIN_TOKEN);
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    next();
    return;
  }
  const authorization = String(req.get("authorization") || "");
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  const headerToken = String(req.get("x-newslive-admin-token") || "");
  if (tokenMatches(bearer || headerToken)) {
    next();
    return;
  }
  res.status(401).json({ ok: false, message: "管理操作需要有效令牌" });
}

const app = express();
const crawler = new NewsCrawler();

app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));
app.use(express.static(PUBLIC_DIR));

app.get("/api/state", (_, res) => {
  res.set("Cache-Control", "no-store");
  res.json(crawler.getState());
});

app.get("/api/meta", (_, res) => {
  const state = crawler.getState();
  res.set("Cache-Control", "no-store");
  res.json({
    crawlVersion: state.crawlVersion,
    inProgress: state.inProgress,
    lastFetchAt: state.lastFetchAt,
    nextFetchAt: state.nextFetchAt,
    pushQueueCount: state.pushQueueCount,
    pushQuietRange: state.pushQuietRange,
    pushQuietUntil: state.pushQuietUntil,
    rankingsGeneratedAt: state.rankingsGeneratedAt,
    rankingPlatforms: state.rankingPlatforms,
    errors: state.errors
  });
});

app.get("/api/archive", async (_, res, next) => {
  try {
    const archive = await loadNewsArchive();
    const items = Array.isArray(archive.items) ? archive.items : [];
    res.json({
      items,
      count: items.length,
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/rankings", async (_, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    res.json(await loadRankings());
  } catch (error) {
    next(error);
  }
});

app.get("/rankings.html", async (_, res, next) => {
  try {
    res.type("html").send(renderRankingsPage(await loadRankings()));
  } catch (error) {
    next(error);
  }
});

app.post("/api/refresh", requireAdmin, async (_, res) => {
  const result = await crawler.run("manual");
  if (result.reason === "min_interval") {
    res.status(429).json({
      ok: false,
      message: `刷新过于频繁，请在 ${Math.ceil(result.waitMs / 1000)} 秒后重试`,
      waitMs: result.waitMs
    });
    return;
  }
  res.json({ ok: true, result, state: crawler.getState() });
});

app.get("*", (_, res) => {
  res.sendFile(path.resolve(PUBLIC_DIR, "index.html"));
});

app.use((error, _, res, __) => {
  console.error("[NewsLive API]", error);
  res.status(500).json({ ok: false, message: "服务器内部错误" });
});

async function boot() {
  if (!isLoopbackHost(HOST) && !ADMIN_TOKEN) {
    throw new Error("HOST 非本机回环地址时必须配置 NEWSLIVE_ADMIN_TOKEN");
  }
  await crawler.hydrateCachedState();

  const scheduleNext = () => {
    const waitMs = Math.max(crawler.getState().intervalMs || 30 * 60 * 1000, 5_000);
    setTimeout(async () => {
      await crawler.run("scheduled");
      scheduleNext();
    }, waitMs);
  };

  app.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`NewsLive running on http://${HOST}:${PORT}`);
  });

  crawler
    .run("startup")
    .catch((error) => console.error("Startup crawl failed", error))
    .finally(scheduleNext);
}

boot().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Boot failed", error);
  process.exit(1);
});
