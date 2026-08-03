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
    <title>NewsLive 今日新闻</title>
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
          <a class="nav-link active" href="./index.html">今日新闻</a>
          <a class="nav-link" href="./rankings.html">实时榜单</a>
          <a class="nav-link" href="./archive.html">新闻归档</a>
        </nav>
      </div>
    </header>

    <main id="pageMain" class="page-main">
      <section class="page-heading">
        <div>
          <p class="eyebrow">Live briefing</p>
          <h1 class="page-title">今日新闻</h1>
          <p class="page-lede">聚合可信新闻来源，按关注主题筛选重点信息，并保留原始报道链接。</p>
        </div>
        <div class="heading-actions">
          <a class="button" href="./archive.html">查看归档</a>
          <button id="filterToggleBtn" type="button" aria-expanded="false">主题与 Tag</button>
          <button id="healthToggleBtn" type="button">来源状态</button>
        </div>
      </section>

      <div class="layout" id="layoutRoot">
        <aside class="filter-sidebar">
          <section class="panel facet-panel">
            <div class="facet-panel-heading">
              <div>
                <h2 class="panel-title">主题与 Tag</h2>
                <p class="meta facet-help">勾选主题后显示所属 Tag，可同时选择多个主题。</p>
              </div>
              <div class="facet-heading-actions">
                <button id="filterResetBtn" class="facet-reset" type="button">重置</button>
                <button id="filterCloseBtn" class="drawer-close" type="button" aria-label="关闭主题与 Tag">×</button>
              </div>
            </div>
            <section class="facet-section" aria-labelledby="topicFilterTitle">
              <h3 id="topicFilterTitle" class="facet-section-title">主题</h3>
              <div id="topicFilterList" class="topic-filter-list"></div>
            </section>
            <section class="facet-section" aria-labelledby="tagFilterTitle">
              <h3 id="tagFilterTitle" class="facet-section-title">Tag</h3>
              <div id="tagGroups" class="tag-groups"></div>
            </section>
          </section>
        </aside>
        <aside class="health-sidebar">
          <section class="panel health-panel">
            <div class="facet-panel-heading">
              <h2 class="panel-title">来源状态</h2>
              <button id="healthCloseBtn" class="drawer-close" type="button" aria-label="关闭来源状态">×</button>
            </div>
            <div id="healthSummary" class="meta health-summary"></div>
            <div id="healthFilters" class="health-filter"></div>
            <div id="healthList" class="health-list"></div>
          </section>
        </aside>
        <div class="news-column">
          <section class="panel filter-panel">
            <div class="filter-top">
              <div id="filterSummary" class="filter-summary">全部新闻</div>
              <div class="search-actions">
                <input id="searchInput" class="search-input" type="search" placeholder="搜索新闻标题" aria-label="搜索新闻标题" />
              </div>
            </div>
            <div id="status" class="status-bar"></div>
          </section>
          <section class="panel news-list" aria-live="polite">
            <div id="list"></div>
          </section>
        </div>
      </div>
    </main>
    <button id="drawerBackdrop" class="drawer-backdrop" type="button" aria-label="关闭侧栏"></button>
    <footer class="site-footer">
      <div class="site-footer-inner">
        <span>NewsLive · 自动聚合公开新闻来源</span>
        <span>点击标题前往原始报道</span>
      </div>
    </footer>
    <button id="topBtn" class="top-btn" aria-label="回到顶部">↑ 顶部</button>

    <script>
      const state = {
        data: ${serialized},
        selectedTopics: new Set(),
        excludedTagsByTopic: new Map(),
        search: "",
        sourceHealthFilter: "__ALL__",
        sourceHealthExpanded: false,
        filterExpanded: false
      };
      const listEl = document.getElementById("list");
      const statusEl = document.getElementById("status");
      const searchInput = document.getElementById("searchInput");
      const filterSummaryEl = document.getElementById("filterSummary");
      const topicFilterListEl = document.getElementById("topicFilterList");
      const tagGroupsEl = document.getElementById("tagGroups");
      const filterToggleBtn = document.getElementById("filterToggleBtn");
      const filterResetBtn = document.getElementById("filterResetBtn");
      const filterCloseBtn = document.getElementById("filterCloseBtn");
      const filterSidebarEl = document.querySelector(".filter-sidebar");
      const healthSummaryEl = document.getElementById("healthSummary");
      const healthFiltersEl = document.getElementById("healthFilters");
      const healthListEl = document.getElementById("healthList");
      const healthToggleBtn = document.getElementById("healthToggleBtn");
      const healthCloseBtn = document.getElementById("healthCloseBtn");
      const healthSidebarEl = document.querySelector(".health-sidebar");
      const layoutRoot = document.getElementById("layoutRoot");
      const drawerBackdrop = document.getElementById("drawerBackdrop");
      const topBtn = document.getElementById("topBtn");

      function escapeBrowserHtml(value) {
        return String(value ?? "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#039;");
      }

      function safeUrl(value) {
        try {
          const url = new URL(String(value || ""), window.location.href);
          return ["http:", "https:"].includes(url.protocol) ? url.href : "#";
        } catch {
          return "#";
        }
      }

      function formatDate(value) {
        if (!value) return "暂无";
        const date = new Date(value);
        if (!Number.isFinite(date.getTime())) return "暂无";
        return date.toLocaleString("zh-CN", { hour12: false });
      }

      function getTopicItemTags(item, topic) {
        const configured = new Map(
          (topic?.keywords || []).map((keyword) => [String(keyword).toLowerCase(), keyword])
        );
        return Array.from(
          new Set(
            (item?.matchedKeywords || [])
              .map((keyword) => configured.get(String(keyword).toLowerCase()))
              .filter(Boolean)
          )
        );
      }

      function getTopicTagStats(topic) {
        const counts = new Map();
        for (const item of state.data?.items || []) {
          if (!(item.matchedTopics || []).includes(topic.id)) continue;
          for (const tag of getTopicItemTags(item, topic)) {
            counts.set(tag, (counts.get(tag) || 0) + 1);
          }
        }
        return Array.from(counts, ([tag, count]) => ({ tag, count })).sort(
          (left, right) => right.count - left.count || left.tag.localeCompare(right.tag, "zh-CN")
        );
      }

      function normalizeFilterState() {
        const topicIds = new Set((state.data?.topics || []).map((topic) => topic.id));
        for (const topicId of state.selectedTopics) {
          if (!topicIds.has(topicId)) {
            state.selectedTopics.delete(topicId);
            state.excludedTagsByTopic.delete(topicId);
          }
        }
      }

      function renderFilterSummary() {
        const topics = state.data?.topics || [];
        const selected = topics.filter((topic) => state.selectedTopics.has(topic.id));
        if (!selected.length) {
          filterSummaryEl.textContent = "全部新闻";
          return;
        }
        let selectedTagCount = 0;
        let availableTagCount = 0;
        for (const topic of selected) {
          const stats = getTopicTagStats(topic);
          const excluded = state.excludedTagsByTopic.get(topic.id) || new Set();
          availableTagCount += stats.length;
          selectedTagCount += stats.filter(({ tag }) => !excluded.has(tag)).length;
        }
        filterSummaryEl.textContent =
          selected.map((topic) => topic.name).join("、") +
          " · Tag " + selectedTagCount + "/" + availableTagCount;
      }

      function renderFacetPanel() {
        normalizeFilterState();
        const data = state.data || { items: [], topics: [] };
        topicFilterListEl.innerHTML = "";
        for (const topic of data.topics || []) {
          const count = (data.items || []).filter((item) =>
            (item.matchedTopics || []).includes(topic.id)
          ).length;
          const label = document.createElement("label");
          label.className = "facet-option" + (state.selectedTopics.has(topic.id) ? " active" : "");
          label.title = topic.description || "";
          const input = document.createElement("input");
          input.type = "checkbox";
          input.checked = state.selectedTopics.has(topic.id);
          input.addEventListener("change", () => {
            if (input.checked) {
              state.selectedTopics.add(topic.id);
              state.excludedTagsByTopic.set(topic.id, new Set());
            } else {
              state.selectedTopics.delete(topic.id);
              state.excludedTagsByTopic.delete(topic.id);
            }
            renderFacetPanel();
            renderList();
          });
          const name = document.createElement("span");
          name.className = "facet-option-name";
          name.textContent = topic.name;
          const countEl = document.createElement("span");
          countEl.className = "facet-count";
          countEl.textContent = String(count);
          label.append(input, name, countEl);
          topicFilterListEl.appendChild(label);
        }

        tagGroupsEl.innerHTML = "";
        const selectedTopics = (data.topics || []).filter((topic) =>
          state.selectedTopics.has(topic.id)
        );
        if (!selectedTopics.length) {
          tagGroupsEl.innerHTML = '<div class="facet-empty">勾选主题后，这里会按主题分组显示对应 Tag。</div>';
          renderFilterSummary();
          return;
        }

        for (const topic of selectedTopics) {
          const stats = getTopicTagStats(topic);
          const excluded = state.excludedTagsByTopic.get(topic.id) || new Set();
          const group = document.createElement("section");
          group.className = "tag-topic-group";
          group.dataset.topicId = topic.id;
          const heading = document.createElement("div");
          heading.className = "tag-topic-heading";
          const title = document.createElement("strong");
          title.textContent = topic.name;
          const selectedCount = stats.filter(({ tag }) => !excluded.has(tag)).length;
          const meta = document.createElement("span");
          meta.className = "facet-count";
          meta.textContent = selectedCount + "/" + stats.length;
          heading.append(title, meta);
          group.appendChild(heading);

          if (!stats.length) {
            const empty = document.createElement("div");
            empty.className = "facet-empty compact";
            empty.textContent = "当前新闻中暂无对应 Tag";
            group.appendChild(empty);
            tagGroupsEl.appendChild(group);
            continue;
          }

          const selectAllLabel = document.createElement("label");
          selectAllLabel.className = "tag-select-all";
          const selectAll = document.createElement("input");
          selectAll.type = "checkbox";
          selectAll.checked = selectedCount === stats.length;
          selectAll.indeterminate = selectedCount > 0 && selectedCount < stats.length;
          selectAll.addEventListener("change", () => {
            const nextExcluded = new Set();
            if (!selectAll.checked) stats.forEach(({ tag }) => nextExcluded.add(tag));
            state.excludedTagsByTopic.set(topic.id, nextExcluded);
            renderFacetPanel();
            renderList();
          });
          selectAllLabel.append(selectAll, document.createTextNode("全部 Tag"));
          group.appendChild(selectAllLabel);

          const tagList = document.createElement("div");
          tagList.className = "tag-filter-list";
          for (const { tag, count } of stats) {
            const tagLabel = document.createElement("label");
            tagLabel.className = "tag-filter-option" + (excluded.has(tag) ? "" : " active");
            tagLabel.title = "所属主题：" + topic.name;
            const tagInput = document.createElement("input");
            tagInput.type = "checkbox";
            tagInput.checked = !excluded.has(tag);
            tagInput.addEventListener("change", () => {
              const nextExcluded = state.excludedTagsByTopic.get(topic.id) || new Set();
              if (tagInput.checked) nextExcluded.delete(tag);
              else nextExcluded.add(tag);
              state.excludedTagsByTopic.set(topic.id, nextExcluded);
              renderFacetPanel();
              renderList();
            });
            const tagText = document.createElement("span");
            tagText.textContent = tag;
            const tagCount = document.createElement("small");
            tagCount.textContent = String(count);
            tagLabel.append(tagInput, tagText, tagCount);
            tagList.appendChild(tagLabel);
          }
          group.appendChild(tagList);
          tagGroupsEl.appendChild(group);
        }
        renderFilterSummary();
      }

      function renderStatus() {
        const d = state.data;
        const parts = [
          "最近构建 " + formatDate(d.generatedAt),
          "上次更新 " + formatDate(d.lastFetchAt),
          "下次更新 " + formatDate(d.nextFetchAt),
          "共 " + ((d.items || []).length) + " 条"
        ];
        if (d.pushQuietRange) parts.push("推送静默至 " + formatDate(d.pushQuietUntil));
        if (Number(d.pushQueueCount) > 0) parts.push("待发送 " + d.pushQueueCount + " 条");
        if (Number(d.filteredOutByDateCount) > 0) parts.push("已忽略非当日 " + d.filteredOutByDateCount + " 条");
        statusEl.textContent = parts.join(" · ");
      }

      function getHealthLabel(status) {
        if (status === "success") return "连接正常";
        if (status === "failed") return "连接失败";
        return "需要检查";
      }

      function renderHealthPanel() {
        const sourceHealth = state.data.sourceHealth || [];
        const summary = state.data.sourceHealthSummary || { success: 0, failed: 0, other: 0 };
        healthSummaryEl.textContent = \`共 \${sourceHealth.length} 个来源 · 正常 \${summary.success || 0} · 失败 \${summary.failed || 0} · 异常 \${summary.other || 0}\`;
        const filters = [
          { id: "__ALL__", label: "全部" },
          { id: "success", label: "正常" },
          { id: "failed", label: "失败" },
          { id: "other", label: "异常" }
        ];
        healthFiltersEl.innerHTML = filters
          .map((f) => \`<button data-health-filter="\${f.id}" class="\${state.sourceHealthFilter === f.id ? "active" : ""}">\${f.label}</button>\`)
          .join("");
        for (const btn of healthFiltersEl.querySelectorAll("button[data-health-filter]")) {
          btn.addEventListener("click", () => {
            state.sourceHealthFilter = btn.getAttribute("data-health-filter");
            renderHealthPanel();
          });
        }
        const filtered = sourceHealth.filter((item) => state.sourceHealthFilter === "__ALL__" || item.status === state.sourceHealthFilter);
        healthListEl.innerHTML = filtered.length
          ? filtered.map((item) => \`
              <article class="health-item">
                <div class="health-item-title"><span class="status-dot \${escapeBrowserHtml(item.status)}" aria-hidden="true"></span><strong>\${escapeBrowserHtml(item.name)}</strong></div>
                <div class="meta">\${getHealthLabel(item.status)} · 获取 \${item.itemCount || 0} 条 · 有效 \${item.usableItemCount ?? item.itemCount ?? 0} 条 · \${escapeBrowserHtml(formatDate(item.checkedAt))}</div>
                \${item.errorMessage && item.status !== "success" ? \`<div class="health-item-error">\${escapeBrowserHtml(item.errorMessage)}</div>\` : ""}
              </article>
            \`).join("")
          : '<div class="empty-state">当前筛选下没有结果</div>';
      }

      function renderLayout() {
        layoutRoot.classList.toggle("filters-expanded", state.filterExpanded);
        layoutRoot.classList.toggle("health-expanded", state.sourceHealthExpanded);
        filterToggleBtn.classList.toggle("active", state.filterExpanded);
        healthToggleBtn.classList.toggle("active", state.sourceHealthExpanded);
        filterToggleBtn.setAttribute("aria-expanded", String(state.filterExpanded));
        healthToggleBtn.setAttribute("aria-expanded", String(state.sourceHealthExpanded));
        filterSidebarEl.setAttribute("aria-hidden", String(!state.filterExpanded));
        healthSidebarEl.setAttribute("aria-hidden", String(!state.sourceHealthExpanded));
        document.body.classList.toggle(
          "drawer-open",
          state.filterExpanded || state.sourceHealthExpanded
        );
      }

      function closeSidebars() {
        state.filterExpanded = false;
        state.sourceHealthExpanded = false;
        renderLayout();
      }

      function renderList() {
        const query = state.search.toLowerCase().trim();
        const filtered = (state.data.items || []).filter((item) => {
          let hitTopicAndTag = state.selectedTopics.size === 0;
          for (const topic of state.data.topics || []) {
            if (!state.selectedTopics.has(topic.id)) continue;
            if (!(item.matchedTopics || []).includes(topic.id)) continue;
            const itemTags = getTopicItemTags(item, topic);
            const excluded = state.excludedTagsByTopic.get(topic.id) || new Set();
            if (itemTags.some((tag) => !excluded.has(tag))) {
              hitTopicAndTag = true;
              break;
            }
          }
          const searchText = (item.title + " " + (item.titleZh || "")).toLowerCase();
          const hitSearch = !query || searchText.includes(query);
          return hitTopicAndTag && hitSearch;
        });
        listEl.innerHTML = filtered.map((item) => {
          const sourceCount = Math.max(Number(item.sourceCount) || 0, (item.relatedSources || []).length, 1);
          const relatedLinks = (item.relatedLinks || []).filter((link) => link && link.url && safeUrl(link.url) !== safeUrl(item.url));
          const ownedTagHtml = (state.data.topics || [])
            .filter((topic) => (item.matchedTopics || []).includes(topic.id))
            .map((topic) => {
              const ownedTags = getTopicItemTags(item, topic);
              if (!ownedTags.length) return "";
              return '<div class="news-tag-group"><span class="tag-owner">' +
                escapeBrowserHtml(topic.name) +
                '</span>' +
                ownedTags.map((tag) => '<span class="tag" title="所属主题：' +
                  escapeBrowserHtml(topic.name) + '">' + escapeBrowserHtml(tag) + '</span>').join("") +
                '</div>';
            })
            .join("");
          return \`
            <article class="news-item \${item.isPriority || (item.matchedPushTopics || []).length ? "is-priority" : ""}">
              <div class="news-meta meta"><span class="source-name" title="\${escapeBrowserHtml((item.relatedSources || []).join("、"))}">\${escapeBrowserHtml(item.source || "未知来源")}\${sourceCount > 1 ? " · " + sourceCount + " 个来源" : ""}</span><span>\${escapeBrowserHtml(formatDate(item.pubDate || item.fetchedAt))}</span></div>
              <h2 class="news-item-title"><a href="\${escapeBrowserHtml(safeUrl(item.url))}" target="_blank" rel="noopener noreferrer">\${escapeBrowserHtml(item.titleZh || item.title || "无标题")}</a></h2>
              \${item.titleZh && item.titleZh !== item.title ? '<div class="title-original">原文：' + escapeBrowserHtml(item.title) + '</div>' : ""}
              \${relatedLinks.length ? '<details class="related-links"><summary>查看其他来源（' + relatedLinks.length + '）</summary><div>' + relatedLinks.map((link) => '<a href="' + escapeBrowserHtml(safeUrl(link.url)) + '" target="_blank" rel="noopener noreferrer">' + escapeBrowserHtml(link.source || link.title || "相关报道") + '</a>').join("") + '</div></details>' : ""}
              <div class="tags">\${ownedTagHtml}</div>
            </article>
          \`;
        }).join("") || '<div class="empty-state">没有匹配结果</div>';
      }

      searchInput.addEventListener("input", (e) => { state.search = e.target.value; renderList(); });
      filterToggleBtn.addEventListener("click", () => {
        state.filterExpanded = !state.filterExpanded;
        if (state.filterExpanded) state.sourceHealthExpanded = false;
        renderLayout();
      });
      healthToggleBtn.addEventListener("click", () => {
        state.sourceHealthExpanded = !state.sourceHealthExpanded;
        if (state.sourceHealthExpanded) state.filterExpanded = false;
        renderLayout();
      });
      filterResetBtn.addEventListener("click", () => {
        state.selectedTopics.clear();
        state.excludedTagsByTopic.clear();
        renderFacetPanel();
        renderList();
      });
      filterCloseBtn.addEventListener("click", closeSidebars);
      healthCloseBtn.addEventListener("click", closeSidebars);
      drawerBackdrop.addEventListener("click", closeSidebars);
      window.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && (state.filterExpanded || state.sourceHealthExpanded)) {
          closeSidebars();
        }
      });
      topBtn.addEventListener("click", () => {
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
      window.addEventListener("scroll", () => {
        topBtn.classList.toggle("show", window.scrollY > 240);
      });
      renderFacetPanel();
      renderStatus();
      renderHealthPanel();
      renderLayout();
      renderList();
    </script>
  </body>
</html>`;
}

export function renderSummaryText(payload) {
  return [
    `生成时间: ${payload.generatedAt}`,
    `获取条数: ${(payload.items || []).length}`,
    `错误数: ${(payload.errors || []).length}`
  ]
    .map((line) => escapeHtml(line))
    .join("\n");
}
