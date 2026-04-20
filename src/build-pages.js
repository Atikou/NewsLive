import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NewsCrawler } from "./crawler.js";
import { renderStaticPage } from "./static-page.js";
import { renderArchiveStaticPage } from "./archive-static-page.js";
import { loadNewsArchive } from "./persistence.js";

const DOCS_DIR = path.resolve(process.cwd(), "docs");

async function main() {
  const crawler = new NewsCrawler();
  const result = await crawler.run("pages_build");
  const state = crawler.getState();
  const payload = {
    ...state,
    generatedAt: new Date().toISOString(),
    buildResult: result
  };
  const archive = await loadNewsArchive();
  const archivePayload = {
    items: Array.isArray(archive.items) ? archive.items : [],
    generatedAt: new Date().toISOString()
  };

  await mkdir(DOCS_DIR, { recursive: true });
  await writeFile(path.resolve(DOCS_DIR, "index.html"), renderStaticPage(payload), "utf-8");
  await writeFile(path.resolve(DOCS_DIR, "state.json"), JSON.stringify(payload, null, 2), "utf-8");
  await writeFile(path.resolve(DOCS_DIR, "archive.html"), renderArchiveStaticPage(archivePayload), "utf-8");
  await writeFile(path.resolve(DOCS_DIR, "archive.json"), JSON.stringify(archivePayload, null, 2), "utf-8");
  await writeFile(path.resolve(DOCS_DIR, ".nojekyll"), "", "utf-8");

  // eslint-disable-next-line no-console
  console.log(`Pages artifacts generated. Items: ${payload.items.length}`);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Build pages failed", error);
  process.exit(1);
});
