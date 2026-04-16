# NewsLive

NewsLive 是一个新闻聚合抓取项目，提供本地可视化页面和 GitHub Pages 静态发布页面（浅色主题）。

## 功能概览

- 默认每 30 分钟自动抓取一次
- 手动刷新最短间隔 2 分钟（防频繁请求）
- 关键词筛选与重点关键词推送
- 重点内容去重持久化（重启后仍生效）
- 多数据源可配置扩展（YAML 驱动）
- GitHub Actions 定时抓取并发布到 GitHub Pages

## 快速开始

```bash
npm install
npm start
```

启动后访问：`http://localhost:5178`

## 配置文件

### `keywords.yaml`

- 每行一个关键词
- `=======` 前：普通关键词（用于页面筛选和命中标记）
- `=======` 后：重点关键词（命中后触发推送）

示例：

```yaml
AI
开源
Google

=======

漏洞
垄断
```

### `sources.yaml`

当前内置默认源（以仓库里的 `sources.yaml` 为准）：

- `hn_cn`（HackerNews 中文版，`html_links`）
- `hn_rss_frontpage`（Hacker News RSS，`rss`）
- `weibo_news`（微博热搜，`browser_html_links`）
- `github_trending`、`zhihu_hot`、`tieba_hot`、`toutiao_hot`、`thepaper_hot`、`mktnews_flash`、`juejin_hot`、`bilibili_hot_search`（参考 `newsnow-main` 适配）

当前支持的来源类型：

- `html_links`：抓取网页中的 `<a>` 链接标题
- `browser_html_links`：使用无头浏览器渲染后抓取链接（适合动态页面）
- `markdown_link_pages`：先提取 markdown 里的链接，再抓取链接页标题
- `rss`：抓取 RSS 源（`<item><title/link>`）
- `json_items`：抓取 JSON 接口并按路径映射标题/链接（适合各类热榜 API）

每个源都支持可选的 `headers` 字段，可用于自定义请求头（例如某些站点要求特定 UA / Referer）。
对于 `browser_html_links`，还支持：

- `wait_for_selector`：等待页面渲染完成的选择器
- `link_selector`：用于提取链接的选择器
- `browser_wait_ms`：额外等待渲染时间

对于 `json_items`，还支持：

- `items_path`：新闻数组在 JSON 中的路径（如 `data.items`）
- `title_path` / `title_paths`：标题字段路径（支持备用路径）
- `url_path` / `url_paths`：链接字段路径（支持备用路径）
- `id_path` / `id_paths`：唯一 ID 字段路径
- `date_path` / `date_paths`：时间字段路径
- `url_template`：当没有现成链接时按模板拼接（如 `https://x.com/{id}`）
- `method`：请求方法（默认 `GET`）

示例：

```yaml
sources:
  - id: hn_cn
    name: HackerNews 中文版
    type: html_links
    url: https://hn.aimaker.dev/
    min_title_length: 8
    max_items: 120

  - id: hn_rss_frontpage
    name: Hacker News RSS
    type: rss
    url: https://hnrss.org/frontpage
    min_title_length: 1
    max_items: 120

  - id: weibo_news
    name: 微博热搜
    type: browser_html_links
    url: https://s.weibo.com/top/summary
    headers:
      User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36
      Referer: https://s.weibo.com/
    wait_for_selector: "#pl_top_realtimehot"
    link_selector: "#pl_top_realtimehot td.td-02 a"
    browser_wait_ms: 10000
    min_title_length: 8
    max_items: 120

  - id: zhihu_hot
    name: 知乎热榜
    type: json_items
    url: https://www.zhihu.com/api/v3/feed/topstory/hot-list-web?limit=20&desktop=true
    items_path: data
    title_path: target.title_area.text
    url_path: target.link.url
    id_path: target.link.url
    min_title_length: 2
    max_items: 60
```

### `setting.yaml`

主要配置项：

- `fetch_interval_minutes`：自动抓取间隔（分钟）
- `min_fetch_interval_minutes`：最短抓取间隔（分钟）
- `request_timeout_seconds`：单请求超时（秒）
- `push.enabled`：是否启用重点推送
- `push.day_app_push_url`：day.app 推送地址（完整 URL）
- `push.repeat_interval_minutes`：同一条重点内容再次允许推送的间隔（分钟）
- `push.max_items_per_push`：单次推送最大条数
- `ui.poll_interval_seconds`：前端轮询状态间隔（秒）

## 推送配置

项目使用 day.app 推送地址。

- 本地开发：可在 `setting.yaml` 填 `push.day_app_push_url`
- GitHub Actions：通过 Secret 注入 `DAY_APP_PUSH_URL`

支持两种推送 URL 形式：

- 普通 URL（自动拼接 `title/body` 查询参数）
- 模板 URL（包含 `{title}` 和 `{body}` 占位符）

## 去重持久化

- 推送历史保存在 `data/notified-history.json`
- 每次抓取后自动更新
- Actions 运行时会回写该文件到仓库，保证跨运行去重

## GitHub Actions + Pages

工作流文件：`.github/workflows/newslive-pages.yml`

流程：

- 每 30 分钟定时运行（可手动触发）
- 执行抓取，生成 `docs/index.html` 与 `docs/state.json`
- 自动提交 `docs/` 和 `data/notified-history.json`
- 自动部署到 GitHub Pages

使用前准备：

1. 在仓库 Secrets 中添加 `DAY_APP_PUSH_URL`
2. 在仓库 `Settings -> Pages` 启用 GitHub Pages（Source 选择 GitHub Actions）
