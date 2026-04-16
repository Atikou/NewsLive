import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NewsCrawler } from "./crawler.js";
import { getKeywordFilePath, getSettingsFilePath, getSourcesFilePath } from "./config.js";
import { getNotifyHistoryPath } from "./persistence.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, "../public");
const PORT = Number(process.env.PORT || 5178);

const app = express();
const crawler = new NewsCrawler();

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

app.get("/api/state", (_, res) => {
  res.json({
    ...crawler.getState(),
    keywordFile: getKeywordFilePath(),
    settingsFile: getSettingsFilePath(),
    sourcesFile: getSourcesFilePath(),
    notifyHistoryFile: getNotifyHistoryPath()
  });
});

app.post("/api/refresh", async (_, res) => {
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

async function boot() {
  await crawler.run("startup");

  const scheduleNext = () => {
    const waitMs = Math.max(crawler.getState().intervalMs || 30 * 60 * 1000, 5_000);
    setTimeout(async () => {
      await crawler.run("scheduled");
      scheduleNext();
    }, waitMs);
  };
  scheduleNext();

  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`NewsLive running on http://localhost:${PORT}`);
  });
}

boot().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Boot failed", error);
  process.exit(1);
});
