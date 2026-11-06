import { RANKING_PLATFORMS } from "./rankings.js";

export function renderRankingsPage(payload) {
  const serialized = JSON.stringify(payload || {}).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="NewsLive 微博、抖音和 Bilibili 国内实时榜单" />
    <title>NewsLive 实时榜单</title>
    <link rel="stylesheet" href="./news-theme.css" />
  </head>
  <body>
    <header class="site-header">
      <div class="header-inner">
        <a class="brand" href="./index.html" aria-label="NewsLive 首页">
          <span class="brand-mark" aria-hidden="true"></span>
          <span class="brand-name">NewsLive</span>
          <span class="brand-note">新闻聚合</span>
        </a>
        <nav class="site-nav" aria-label="主导航">
          <a class="nav-link" href="./index.html">今日新闻</a>
          <a class="nav-link active" href="./rankings.html">实时榜单</a>
          <a class="nav-link" href="./archive.html">新闻归档</a>
        </nav>
      </div>
    </header>

    <main class="page-main rankings-main">
      <section class="page-heading rankings-heading">
        <div>
          <p class="eyebrow">Domestic trends</p>
          <h1 class="page-title">实时榜单</h1>
          <p class="page-lede">汇总微博、抖音与 Bilibili 公开热榜。页面随新闻任务更新，榜单每天仅定时推送两次。</p>
        </div>
        <div class="ranking-updated" id="rankingUpdated"></div>
      </section>

      <section class="panel ranking-toolbar" aria-label="榜单筛选">
        <div class="ranking-tabs" id="rankingTabs">
          <button class="active" type="button" data-platform="all">综合</button>
          ${RANKING_PLATFORMS.map(
            (platform) => `<button type="button" data-platform="${platform.key}">${platform.name}</button>`
          ).join("")}
        </div>
        <div class="meta" id="rankingSummary"></div>
      </section>

      <div class="ranking-grid" id="rankingGrid"></div>
    </main>

    <footer class="site-footer">
      <div class="site-footer-inner">
        <span>NewsLive · 国内公开热榜</span>
        <span>轻量抓取 · 原始链接直达</span>
      </div>
    </footer>
    <button id="topBtn" class="top-btn" type="button" aria-label="回到顶部">↑ 顶部</button>

    <script>
      const data = ${serialized};
      const platformOrder = ${JSON.stringify(RANKING_PLATFORMS.map(({ key, name }) => ({ key, name })))};
      const state = { platform: "all" };
      const gridEl = document.getElementById("rankingGrid");
      const tabsEl = document.getElementById("rankingTabs");
      const summaryEl = document.getElementById("rankingSummary");
      const updatedEl = document.getElementById("rankingUpdated");
      const topBtn = document.getElementById("topBtn");

      function escapeHtml(value) {
        return String(value ?? "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#039;");
      }

      function safeUrl(value) {
        try {
          const url = new URL(String(value || ""));
          return url.protocol === "https:" ? url.href : "#";
        } catch {
          return "#";
        }
      }

      function formatTime(value) {
        const date = new Date(value || "");
        if (!Number.isFinite(date.getTime())) return "尚未更新";
        return date.toLocaleString("zh-CN", { hour12: false });
      }

      function movement(item) {
        if (item.isNew) return '<span class="rank-change new">新</span>';
        if (item.rankChange > 0) return '<span class="rank-change up">↑' + item.rankChange + '</span>';
        if (item.rankChange < 0) return '<span class="rank-change down">↓' + Math.abs(item.rankChange) + '</span>';
        return '<span class="rank-change flat">—</span>';
      }

      function renderPlatform(definition) {
        const platform = data.platforms?.[definition.key] || {};
        const items = Array.isArray(platform.items) ? platform.items : [];
        const statusClass = platform.status === "success" ? "success" : platform.stale ? "stale" : "failed";
        const statusText = platform.status === "success" ? "已更新" : platform.stale ? "旧数据" : "获取失败";
        const rows = items.length
          ? items.map((item) => \`
              <a class="ranking-row" href="\${escapeHtml(safeUrl(item.url))}" target="_blank" rel="noopener noreferrer">
                <span class="rank-number \${item.rank <= 3 ? "top" : ""}">\${item.rank}</span>
                <span class="rank-title">\${escapeHtml(item.title)}</span>
                \${movement(item)}
              </a>
            \`).join("")
          : '<div class="empty-state ranking-empty">暂时没有可用榜单数据</div>';
        return \`
          <section class="panel ranking-card" data-platform-card="\${definition.key}">
            <header class="ranking-card-header">
              <div>
                <h2>\${escapeHtml(definition.name)}</h2>
                <span class="meta">\${items.length} 条 · \${escapeHtml(formatTime(platform.updatedAt))}</span>
              </div>
              <span class="ranking-status \${statusClass}">\${statusText}</span>
            </header>
            \${platform.errorMessage ? '<div class="ranking-error">' + escapeHtml(platform.errorMessage) + '</div>' : ""}
            <div class="ranking-list">\${rows}</div>
          </section>
        \`;
      }

      function render() {
        const visible = state.platform === "all"
          ? platformOrder
          : platformOrder.filter((item) => item.key === state.platform);
        gridEl.innerHTML = visible.map(renderPlatform).join("");
        const total = visible.reduce((sum, item) => sum + (data.platforms?.[item.key]?.items?.length || 0), 0);
        const healthy = visible.filter((item) => data.platforms?.[item.key]?.status === "success").length;
        summaryEl.textContent = \`\${visible.length} 个平台 · \${healthy} 个已更新 · \${total} 条\`;
        tabsEl.querySelectorAll("button").forEach((button) => {
          button.classList.toggle("active", button.dataset.platform === state.platform);
        });
      }

      tabsEl.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-platform]");
        if (!button) return;
        state.platform = button.dataset.platform;
        render();
      });
      topBtn.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
      window.addEventListener("scroll", () => topBtn.classList.toggle("show", window.scrollY > 260));

      updatedEl.textContent = \`最近检查：\${formatTime(data.checkedAt || data.generatedAt)}\`;
      render();
    </script>
  </body>
</html>`;
}
