# NewsLive 项目简要总结

## 项目定位

NewsLive 是一个新闻聚合与筛选工具，支持本地网页运行和 GitHub Pages 静态发布。  
核心目标是：按配置抓取多源新闻、按个人关注主题匹配、可选 AI 翻译、重点内容推送，并保留当天新闻与归档能力。

## 主要能力

- 轻量多源抓取（`html_links` / `rss` / `json_items` / `markdown_link_pages`，无需 Chromium）
- 国内实时榜单（微博 / 抖音 / Bilibili，独立页面与每日两次定时推送）
- 关注主题体系（主题名称、启用开关、推送开关与同义关键词）
- AI 标题翻译（DeepSeek V4 原生接口，兼容旧 Anthropic 配置）
- 仅保留当日新闻（按 `pubDate` 过滤）
- 事件级聚合（规范链接 + 相似标题，多来源报道合并展示）
- 可靠推送（持久化队列、静默补发、day.app / ntfy 分渠道投递账本）
- 源健康检查面板（🟢 / 🔴 / 🟠）
- 归档功能（按配置定期清理并可归档）

## 页面与接口

- 本地主页：`/`（新闻列表、关注主题筛选、源健康状态）
- 榜单页：`/rankings.html`（综合与单平台榜单）
- 归档页：`/archive.html`（按日期 + 标签双筛选）
- API：
  - `GET /api/state`
  - `POST /api/refresh`
  - `GET /api/archive`
  - `GET /api/rankings`

## 运行方式

- 本地服务：`npm start`
- 构建静态页：`npm run build:pages`
- 测试源连接（支持本地代理）：`npm run test:sources`
- 清空归档：`npm run archive:clear`

## 配置与数据

- 非敏感配置：`setting.yaml`、`sources.yaml`、`topics.yaml`
- 敏感配置：`.env`（已被 git 忽略）
- 本地代理测试配置：`proxy.local.json`（已被 git 忽略）
- 持久化数据目录：`data/`（事件、当日新闻、归档、榜单快照、推送队列与投递账本）

## 自动化

- GitHub Actions 工作流支持定时运行（当前为每 30 分钟）并发布到 Pages。
