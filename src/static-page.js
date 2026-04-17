function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderStaticPage(payload) {
  const serialized = JSON.stringify(payload).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>NewsLive Pages</title>
    <style>
      body { margin: 0; font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; background: #f8fafc; color: #0f172a; }
      main { width: min(1100px, 94vw); margin: 24px auto 48px; }
      .panel { background: #ffffff; border: 1px solid #dbeafe; border-radius: 12px; padding: 12px; margin-bottom: 12px; }
      .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
      button,input { border: 1px solid #cbd5e1; border-radius: 8px; background: #ffffff; color: #0f172a; padding: 8px 12px; }
      button.active { border-color: #2563eb; color: #1d4ed8; }
      .item { border: 1px solid #e2e8f0; border-radius: 10px; padding: 10px 12px; margin-bottom: 8px; background: #ffffff; }
      .title-original { color: #64748b; font-size: 13px; margin-top: 6px; }
      .meta { color: #64748b; font-size: 13px; }
      .tag { border-radius: 999px; font-size: 12px; padding: 2px 8px; border: 1px solid #cbd5e1; color: #334155; margin-right: 6px; }
      .priority { border-color: #f59e0b; color: #92400e; }
      a { color: #2563eb; text-decoration: none; }
    </style>
  </head>
  <body>
    <main>
      <h1>NewsLive（GitHub Pages）</h1>
      <div class="panel">
        <div class="row" style="justify-content: space-between">
          <div class="row" id="keywordButtons"></div>
          <input id="searchInput" placeholder="搜索标题..." />
        </div>
        <div id="status" class="meta"></div>
      </div>
      <div class="panel">
        <div id="list"></div>
      </div>
    </main>

    <script>
      const state = {
        data: ${serialized},
        selectedKeyword: "__ALL__",
        search: ""
      };
      const keywordButtons = document.getElementById("keywordButtons");
      const listEl = document.getElementById("list");
      const statusEl = document.getElementById("status");
      const searchInput = document.getElementById("searchInput");

      function formatDate(value) {
        if (!value) return "暂无";
        return new Date(value).toLocaleString("zh-CN", { hour12: false });
      }

      function buildKeywordButtons() {
        const allKeywords = ["__ALL__", ...(state.data.keywords || [])];
        keywordButtons.innerHTML = "";
        for (const keyword of allKeywords) {
          const btn = document.createElement("button");
          btn.textContent = keyword === "__ALL__" ? "全部关键词" : keyword;
          btn.className = keyword === state.selectedKeyword ? "active" : "";
          btn.onclick = () => { state.selectedKeyword = keyword; buildKeywordButtons(); renderList(); };
          keywordButtons.appendChild(btn);
        }
      }

      function renderStatus() {
        const d = state.data;
        statusEl.textContent =
          "最近构建: " + formatDate(d.generatedAt) +
          " | 上次抓取: " + formatDate(d.lastFetchAt) +
          " | 下次抓取(计划): " + formatDate(d.nextFetchAt) +
          " | 总条数: " + ((d.items || []).length);
      }

      function renderList() {
        const keyword = state.selectedKeyword;
        const query = state.search.toLowerCase().trim();
        const filtered = (state.data.items || []).filter((item) => {
          const hitKeyword = keyword === "__ALL__" || (item.matchedKeywords || []).includes(keyword);
          const searchText = (item.title + " " + (item.titleZh || "")).toLowerCase();
          const hitSearch = !query || searchText.includes(query);
          return hitKeyword && hitSearch;
        });
        listEl.innerHTML = filtered.map((item) => \`
          <article class="item">
            <div><a href="\${item.url}" target="_blank" rel="noopener noreferrer">\${item.titleZh || item.title}</a></div>
            \${item.titleZh && item.titleZh !== item.title ? '<div class="title-original">原文: ' + item.title + '</div>' : ""}
            <div class="meta">来源: \${item.source} | 抓取时间: \${formatDate(item.fetchedAt)}</div>
            <div style="margin-top: 8px;">
              \${(item.matchedKeywords || []).map((k) => '<span class="tag">' + k + '</span>').join("")}
              \${(item.matchedPriorityKeywords || []).map((k) => '<span class="tag priority">重点:' + k + '</span>').join("")}
            </div>
          </article>
        \`).join("") || '<div class="meta">没有匹配结果</div>';
      }

      searchInput.addEventListener("input", (e) => { state.search = e.target.value; renderList(); });
      buildKeywordButtons();
      renderStatus();
      renderList();
    </script>
  </body>
</html>`;
}

export function renderSummaryText(payload) {
  return [
    `生成时间: ${payload.generatedAt}`,
    `抓取条数: ${(payload.items || []).length}`,
    `错误数: ${(payload.errors || []).length}`
  ]
    .map((line) => escapeHtml(line))
    .join("\n");
}
