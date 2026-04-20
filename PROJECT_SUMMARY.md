# NewsLive 项目简要总结

## 项目定位

NewsLive 是一个新闻聚合与筛选工具，支持本地网页运行和 GitHub Pages 静态发布。  
核心目标是：按配置抓取多源新闻、进行关键词匹配、可选 AI 翻译、重点内容推送，并保留当天新闻与归档能力。

## 主要能力

- 多源抓取（`html_links` / `browser_html_links` / `rss` / `json_items` / `markdown_link_pages`）
- 关键词体系（普通关键词 + 重点关键词）
- AI 标题翻译（Anthropic 接口兼容）
- 仅保留当日新闻（按 `pubDate` 过滤）
- 同日去重处理（已抓取新闻不重复参与新增推送）
- 推送支持（day.app / ntfy）
- 源健康检查面板（🟢 / 🔴 / 🟠）
- 归档功能（按配置定期清理并可归档）

## 页面与接口

- 本地主页：`/`（新闻列表、关键词筛选、源健康状态）
- 归档页：`/archive.html`（按日期 + 标签双筛选）
- API：
  - `GET /api/state`
  - `POST /api/refresh`
  - `GET /api/archive`

## 运行方式

- 本地服务：`npm start`
- 构建静态页：`npm run build:pages`
- 测试源连接（支持本地代理）：`npm run test:sources`
- 清空归档：`npm run archive:clear`

## 配置与数据

- 非敏感配置：`setting.yaml`、`sources.yaml`、`keywords.yaml`
- 敏感配置：`.env`（已被 git 忽略）
- 本地代理测试配置：`proxy.local.json`（已被 git 忽略）
- 持久化数据目录：`data/`（去重、当日新闻、归档）

## 自动化

- GitHub Actions 工作流支持定时运行（当前为每 30 分钟）并发布到 Pages。
