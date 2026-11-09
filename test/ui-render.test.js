import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { renderArchiveStaticPage } from "../src/archive-static-page.js";
import { renderStaticPage } from "../src/static-page.js";
import { renderRankingsPage } from "../src/rankings-page.js";

test("本地与静态归档搜索支持中英文、清空和日期标签组合筛选", async () => {
  const items = [
    { title: "人工智能新闻", publishedAt: "2026-11-08T12:00:00+08:00", tags: ["科技"], relatedLinks: [{ title: "OpenAI launch", url: "https://example.com/ai" }] },
    { title: "OpenAI 新模型", publishedAt: "2026-11-09T12:00:00+08:00", tags: ["科技"] },
    { title: "今日体育", publishedAt: "2026-11-09T12:00:00+08:00", tags: ["体育"] }
  ];
  const pages = [
    await readFile(new URL("../public/archive.html", import.meta.url), "utf-8"),
    renderArchiveStaticPage({ items })
  ];
  for (const html of pages) {
    const elements = new Map();
    const document = {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, {
          value: "", textContent: "", innerHTML: "", listeners: {},
          addEventListener(type, listener) { this.listeners[type] = listener; },
          replaceChildren() {}, appendChild() {}
        });
        return elements.get(id);
      },
      createElement() { return {}; }
    };
    const context = vm.createContext({
      document, URL,
      window: { location: { href: "https://example.com/archive.html" }, addEventListener() {} },
      NewsSelect: { enhance() {} },
      fetch: async () => ({ ok: true, json: async () => ({ items }) })
    });
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
    await vm.runInContext(script, context);
    const change = (id, value, type = "change") => {
      const element = elements.get(id);
      element.value = value;
      element.listeners[type]();
    };
    const count = (n) => assert.equal(elements.get("summary").textContent, `归档 3 条 · 当前显示 ${n} 条`);
    count(3);
    change("searchInput", "  OPENai  ", "input");
    count(2);
    change("dateFilter", "2026-11-09");
    count(1);
    change("tagFilter", "体育");
    count(0);
    assert.match(elements.get("list").innerHTML, /没有匹配的归档新闻/);
    change("searchInput", "", "input");
    count(1);
    assert.match(elements.get("list").innerHTML, /今日体育/);
    change("dateFilter", "__ALL__");
    change("tagFilter", "__ALL__");
    change("searchInput", "人工智能", "input");
    count(1);
    change("searchInput", "   ", "input");
    count(3);
  }
});

test("静态首页使用共享新闻主题并保留核心交互入口", () => {
  const html = renderStaticPage({
    items: [],
    topics: [{ id: "ai-agents", name: "AI 与 Agent", enabled: true, push: true }],
    sourceHealth: [],
    sourceHealthSummary: {}
  });

  assert.match(html, /href="\.\/news-theme\.css"/);
  assert.match(html, /class="site-header"/);
  assert.match(html, /class="panel news-list"/);
  assert.match(html, /id="filterToggleBtn"/);
  assert.match(html, /id="healthToggleBtn"/);
  assert.match(html, /id="topicFilterList"/);
  assert.match(html, /id="tagGroups"/);
  assert.match(html, /id="drawerBackdrop"/);
  assert.doesNotMatch(html, /<style>/);
});

test("静态归档页采用统一标题且不再显示静态字样", () => {
  const html = renderArchiveStaticPage({ items: [] });

  assert.match(html, /<h1 class="page-title">新闻归档<\/h1>/);
  assert.match(html, /href="\.\/news-theme\.css"/);
  assert.match(html, /id="dateFilter"/);
  assert.match(html, /id="tagFilter"/);
  assert.match(html, /src="\.\/news-select\.js"/);
  assert.match(html, /NewsSelect\.enhance\(dateFilter\)/);
  assert.doesNotMatch(html, /归档新闻（静态）/);
  assert.doesNotMatch(html, /<style>/);
});

test("本地动态页面同样使用共享主题", async () => {
  const [indexHtml, archiveHtml] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf-8"),
    readFile(new URL("../public/archive.html", import.meta.url), "utf-8")
  ]);

  assert.match(indexHtml, /href="\/news-theme\.css"/);
  assert.match(archiveHtml, /href="\/news-theme\.css"/);
  assert.match(archiveHtml, /src="\/news-select\.js"/);
  assert.doesNotMatch(indexHtml, /<style>/);
  assert.doesNotMatch(archiveHtml, /<style>/);
});

test("自定义下拉组件保留原生值并提供键盘交互", async () => {
  const script = await readFile(new URL("../public/news-select.js", import.meta.url), "utf-8");

  assert.match(script, /select\.dispatchEvent\(new Event\("change"/);
  assert.match(script, /event\.key === "ArrowDown"/);
  assert.match(script, /event\.key === "Escape"/);
  assert.match(script, /setAttribute\("role", "option"\)/);
});

test("回到顶部按钮拥有清晰的独立悬停状态", async () => {
  const css = await readFile(new URL("../public/news-theme.css", import.meta.url), "utf-8");
  const hoverRule = css.match(/\.top-btn:hover\s*\{([^}]+)\}/);

  assert.ok(hoverRule, "应定义回到顶部按钮的悬停样式");
  assert.match(hoverRule[1], /background:\s*var\(--accent-hover\)/);
  assert.match(hoverRule[1], /color:\s*#fff/);
});

test("主题与来源作为独立侧栏且不改变主内容宽度", async () => {
  const [css, indexHtml] = await Promise.all([
    readFile(new URL("../public/news-theme.css", import.meta.url), "utf-8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf-8")
  ]);

  assert.match(css, /\.layout\.health-expanded \.health-sidebar\s*\{[^}]*position:\s*absolute/);
  assert.match(css, /left:\s*calc\(50% \+ 560px\)/);
  assert.match(css, /\.layout\.filters-expanded \.filter-sidebar\s*\{[^}]*right:\s*calc\(50% \+ 560px\)/);
  assert.doesNotMatch(css, /\.layout\.health-expanded \.news-column/);
  assert.doesNotMatch(css, /\.layout\.filters-expanded \.news-column/);
  assert.doesNotMatch(css, /\.page-main\.main-with-health/);
  assert.doesNotMatch(indexHtml, /main-with-health/);
});

test("手机端侧栏从左侧滑入并通过反向动画退出", async () => {
  const [css, indexHtml] = await Promise.all([
    readFile(new URL("../public/news-theme.css", import.meta.url), "utf-8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf-8")
  ]);

  assert.match(css, /transform:\s*translateX\(-105%\)/);
  assert.match(css, /transform:\s*translateX\(0\)/);
  assert.match(css, /transition:\s*transform 240ms/);
  assert.match(css, /body\.drawer-open \.drawer-backdrop/);
  assert.match(indexHtml, /event\.key === "Escape"/);
  assert.match(indexHtml, /drawerBackdrop\.addEventListener\("click", closeSidebars\)/);
});

test("短页面的底部栏贴住视口底部且不覆盖长内容", async () => {
  const css = await readFile(new URL("../public/news-theme.css", import.meta.url), "utf-8");

  assert.match(css, /body\s*\{[^}]*min-height:\s*100dvh[^}]*display:\s*flex[^}]*flex-direction:\s*column/s);
  assert.match(css, /\.page-main\s*\{[^}]*flex:\s*1 0 auto/s);
  assert.match(css, /\.site-footer\s*\{[^}]*margin-top:\s*auto/s);
  assert.doesNotMatch(css, /\.site-footer\s*\{[^}]*position:\s*fixed/s);
});

test("页面会展示推送队列状态和多来源事件入口", async () => {
  const dynamicPage = await readFile(new URL("../public/index.html", import.meta.url), "utf-8");
  const staticTemplate = await readFile(new URL("../src/static-page.js", import.meta.url), "utf-8");
  assert.match(dynamicPage, /pushQueueCount/);
  assert.match(dynamicPage, /pushQuietRange/);
  assert.match(dynamicPage, /查看其他来源/);
  assert.match(staticTemplate, /查看其他来源/);
});

test("动态页面先轮询轻量状态，版本变化后才重新获取完整新闻", async () => {
  const dynamicPage = await readFile(new URL("../public/index.html", import.meta.url), "utf-8");

  assert.match(dynamicPage, /fetch\("\/api\/meta"/);
  assert.match(dynamicPage, /async function refreshStateIfChanged\(\)/);
  assert.match(dynamicPage, /meta\.crawlVersion !== current\.crawlVersion/);
});

test("来源状态同时展示抓取数量和有效发布时间数量", async () => {
  const [dynamicPage, staticTemplate] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf-8"),
    readFile(new URL("../src/static-page.js", import.meta.url), "utf-8")
  ]);

  assert.match(dynamicPage, /usableItemCount/);
  assert.match(staticTemplate, /usableItemCount/);
});

test("榜单页使用共享主题、独立导航和平台筛选", () => {
  const html = renderRankingsPage({
    checkedAt: "2026-08-03T04:00:00Z",
    platforms: {
      weibo: {
        status: "success",
        items: [{ rank: 1, title: "测试热点", url: "https://s.weibo.com/weibo?q=test" }]
      }
    }
  });
  assert.match(html, /href="\.\/news-theme\.css"/);
  assert.match(html, /class="nav-link active" href="\.\/rankings\.html"/);
  assert.match(html, /data-platform="weibo"/);
  assert.match(html, /class="ranking-grid"/);
  assert.doesNotMatch(html, /<style>/);
});

test("新闻与归档页面都能进入实时榜单", async () => {
  const [dynamicPage, dynamicArchive, staticPage, staticArchive] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf-8"),
    readFile(new URL("../public/archive.html", import.meta.url), "utf-8"),
    readFile(new URL("../src/static-page.js", import.meta.url), "utf-8"),
    readFile(new URL("../src/archive-static-page.js", import.meta.url), "utf-8")
  ]);
  for (const html of [dynamicPage, dynamicArchive, staticPage, staticArchive]) {
    assert.match(html, /rankings\.html/);
  }
});

test("首页按多选主题及所属 Tag 分组筛选", async () => {
  const [dynamicPage, staticTemplate] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf-8"),
    readFile(new URL("../src/static-page.js", import.meta.url), "utf-8")
  ]);
  for (const html of [dynamicPage, staticTemplate]) {
    assert.match(html, /selectedTopics/);
    assert.match(html, /excludedTagsByTopic/);
    assert.match(html, /matchedTopics/);
    assert.match(html, /matchedKeywords/);
    assert.match(html, /tag-topic-group/);
    assert.match(html, /tag-owner/);
    assert.match(html, /勾选主题后/);
    assert.doesNotMatch(html, /selectedTopic:\s*"__ALL__"/);
    assert.doesNotMatch(html, /selectedKeyword/);
    assert.doesNotMatch(html, /keywordButtons/);
  }
});
