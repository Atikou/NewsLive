import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderArchiveStaticPage } from "./archive-static-page.js";
import { loadSettings, loadTopics } from "./config.js";
import { clusterNewsItems, repairNewsClusters } from "./news-cluster.js";
import { loadNewsArchive, loadNewsDays } from "./persistence.js";
import { renderStaticPage } from "./static-page.js";
import { getLocalDateKey } from "./zoned-time.js";
import { tagItemWithTopics } from "./topics.js";
import { loadRankings } from "./rankings.js";
import { renderRankingsPage } from "./rankings-page.js";

const DOCS_DIR = path.resolve(process.cwd(), "docs");
const THEME_FILE = path.resolve(process.cwd(), "public", "news-theme.css");
const SELECT_FILE = path.resolve(process.cwd(), "public", "news-select.js");

async function readJson(fileName, fallback) {
  try {
    const content = await readFile(path.resolve(DOCS_DIR, fileName), "utf-8");
    return JSON.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function main() {
  const [previousState, previousArchive, newsDays, newsArchive, settings, topics, rankings] = await Promise.all([
    readJson("state.json", { items: [], keywords: [] }),
    readJson("archive.json", { items: [] }),
    loadNewsDays(),
    loadNewsArchive(),
    loadSettings(),
    loadTopics(),
    loadRankings()
  ]);
  const dateKey = getLocalDateKey(new Date(), settings.timezone);
  const cachedItems = newsDays.days?.[dateKey];
  const state = {
    ...previousState,
    items: Array.isArray(cachedItems)
      ? clusterNewsItems(repairNewsClusters(cachedItems)).map((item) =>
          tagItemWithTopics(item, topics)
        )
      : previousState.items || [],
    topics,
    generatedAt: new Date().toISOString()
  };
  const archive = {
    ...previousArchive,
    items: Array.isArray(newsArchive.items) ? newsArchive.items : previousArchive.items || [],
    generatedAt: new Date().toISOString()
  };

  await mkdir(DOCS_DIR, { recursive: true });
  await Promise.all([
    writeFile(path.resolve(DOCS_DIR, "index.html"), renderStaticPage(state), "utf-8"),
    writeFile(path.resolve(DOCS_DIR, "archive.html"), renderArchiveStaticPage(archive), "utf-8"),
    writeFile(path.resolve(DOCS_DIR, "state.json"), JSON.stringify(state, null, 2), "utf-8"),
    writeFile(path.resolve(DOCS_DIR, "archive.json"), JSON.stringify(archive, null, 2), "utf-8"),
    writeFile(path.resolve(DOCS_DIR, "rankings.html"), renderRankingsPage(rankings), "utf-8"),
    writeFile(path.resolve(DOCS_DIR, "rankings.json"), JSON.stringify(rankings, null, 2), "utf-8"),
    copyFile(THEME_FILE, path.resolve(DOCS_DIR, "news-theme.css")),
    copyFile(SELECT_FILE, path.resolve(DOCS_DIR, "news-select.js")),
    writeFile(path.resolve(DOCS_DIR, ".nojekyll"), "", "utf-8")
  ]);

  // eslint-disable-next-line no-console
  console.log(
    `UI artifacts rebuilt from persisted data. News: ${(state.items || []).length}, archive: ${(archive.items || []).length}`
  );
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("UI build failed", error);
  process.exit(1);
});
