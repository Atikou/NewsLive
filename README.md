# NewsLive

NewsLive 是一个可本地运行、可自动化部署到 GitHub Pages 的新闻聚合工具。  
它支持多源抓取、关键词筛选、重点推送、AI 标题翻译（Anthropic 接口兼容）以及“仅保留当日新闻”的时效过滤。

## 核心能力

- 多源抓取：支持 `html_links`、`browser_html_links`、`rss`、`json_items`、`markdown_link_pages`
- 关键词体系：普通关键词筛选 + 重点关键词推送
- AI 翻译：抓取后将英文标题翻译为中文，保留原标题
- 时效控制：仅保留 `pubDate` 为“本地当天”的新闻
- 推送去重：同一条重点内容支持重复推送间隔控制
- 推送拆包：按消息体积拆分；day.app 额外做 URL 长度保护，避免 431
- 双形态页面：
  - 本地动态页面：`public/index.html` + `/api/state`
  - 静态页面产物：`docs/index.html` + `docs/state.json`

## 技术栈

- Node.js `>=20`
- Express
- Cheerio
- Playwright
- YAML
- dotenv

## 快速开始

### 1) 安装依赖

```bash
npm install
```

### 2) 配置环境变量

复制示例文件：

```bash
cp .env.example .env
```

填写 `.env`（示例）：

```bash
ANTHROPIC_API_KEY=your_anthropic_compatible_api_key
ANTHROPIC_API_URL=https://api.deepseek.com/anthropic/v1/messages
ANTHROPIC_MODEL=deepseek-chat
DAY_APP_PUSH_URL=https://api.day.app/your_push_key/
NTFY_PUSH_URL=https://ntfy.example.com/your_topic
```

### 3) 本地启动

```bash
npm start
```

默认地址：`http://localhost:5178`

### 4) 生成静态页面（用于 Pages）

```bash
npm run build:pages
```

## 配置说明

### `keywords.yaml`

- 每行一个关键词
- `=======` 前：普通关键词
- `=======` 后：重点关键词（命中后触发推送逻辑）

示例：

```yaml
AI
开源
Linux

=======

漏洞
裁员
```

### `sources.yaml`

抓取源由 `sources.yaml` 驱动。当前仓库示例包含：

- AP News
- Hacker News（HTML / RSS / Algolia JSON）
- Lobsters RSS
- ProPublica

支持类型与常用字段：

- `html_links`
  - `url` `min_title_length` `max_items`
- `browser_html_links`
  - 额外支持 `wait_for_selector` `link_selector` `browser_wait_ms` `headers`
- `rss`
  - 自动抽取 `title` / `link` / `pubDate`（含部分兼容字段）
- `json_items`
  - `items_path` `title_path(s)` `url_path(s)` `id_path(s)` `date_path(s)` `url_template` `method`
- `markdown_link_pages`
  - 从 markdown 提取链接后回抓页面标题

### `setting.yaml`

非敏感配置放在 `setting.yaml`，敏感配置放在 `.env`。

主要配置项：

- `fetch_interval_minutes`：自动抓取间隔（分钟）
- `min_fetch_interval_minutes`：手动/自动抓取最短间隔（分钟）
- `request_timeout_seconds`：单请求超时（秒）
- `pause_time_ranges`：暂停时间段（格式 `时-分 to 时-分`，支持跨天）
- `ai_translation.*`：翻译开关、批量大小、超时、请求头等（不含 key）
- `push.*`：推送开关、重复间隔、黑名单、消息长度上限等
- `ui.poll_interval_seconds`：前端轮询间隔

> 注意：AI 翻译与推送 URL 已改为仅从环境变量读取，不再从 `setting.yaml` 读取密钥/地址。

## 环境变量（`.env`）

- `ANTHROPIC_API_KEY`：AI 翻译 API Key（必填，启用翻译时）
- `ANTHROPIC_API_URL`：Anthropic Messages 兼容接口地址
- `ANTHROPIC_MODEL`：模型名
- `DAY_APP_PUSH_URL`：day.app 推送地址（可选）
- `NTFY_PUSH_URL`：ntfy 推送地址（可选）
- `PORT`：本地服务端口（默认 5178）

## 抓取与推送行为细节

### 仅保留当日新闻

抓取后会检查每条新闻的 `pubDate`：

- 无 `pubDate` 或无法解析：过滤
- `pubDate` 非本地当天：过滤

被过滤数量会体现在状态里（`filteredOutByDateCount`）。

### 关键词命中规则

- 匹配范围仅标题（含翻译后标题），不再匹配 URL
- 英文关键词（如 `AI`）按“完整词”匹配，减少误命中（如 `detail`）

### 推送拆分与长度控制

- 先按 `push.max_message_chars`（默认 4096）构建消息
- day.app 额外按最终 URL 长度控制（内部保护），超长会截断并重试
- 同一条重点内容根据 `push.repeat_interval_minutes` 去重

## 本地 API

- `GET /api/state`：当前状态与新闻列表
- `POST /api/refresh`：手动触发抓取
  - 可能返回 `429`（最小间隔限制）
  - 可能返回 `423`（命中暂停时间段）

## GitHub Actions 与 Pages

主工作流：`.github/workflows/newslive-pages.yml`

流程：

1. 定时/手动触发
2. `npm ci` + 安装 Playwright Chromium
3. 执行 `npm run build:pages`
4. 自动提交 `docs/` 与 `data/notified-history.json`
5. 发布到 GitHub Pages

在仓库 Secrets 中配置：

- `DAY_APP_PUSH_URL`
- `NTFY_PUSH_URL`（可选）
- `ANTHROPIC_API_KEY`（启用翻译时必填）
- `ANTHROPIC_API_URL`（例如 `https://api.deepseek.com/anthropic/v1/messages`）
- `ANTHROPIC_MODEL`（例如 `deepseek-chat`）

## 目录结构（关键文件）

- `src/server.js`：本地服务与 API
- `src/crawler.js`：抓取编排、过滤、翻译、推送、状态管理
- `src/sources.js`：多类型抓取器实现
- `src/ai-translate.js`：Anthropic 兼容翻译客户端
- `src/config.js`：配置加载（含 `.env`）
- `src/build-pages.js`：静态页面构建
- `public/index.html`：本地动态前端
- `docs/`：静态页面产物

## 安全建议

- 不要把真实密钥写入仓库文件
- `.env` 已被 `.gitignore` 忽略
- 如密钥曾暴露，请立即在供应商后台轮换

## License

项目使用仓库中的 `LICENSE`。
