# NewsLive

NewsLive 是一个可本地运行、可自动化部署到 GitHub Pages 的新闻聚合工具。  
它支持多源获取、关键词筛选、重点推送、AI 标题翻译（Anthropic 接口兼容）以及“仅保留当日新闻”的时效过滤。

## 核心能力

- 多源获取：支持 `html_links`、`browser_html_links`、`rss`、`json_items`、`markdown_link_pages`
- 关键词体系：普通关键词筛选 + 重点关键词推送
- AI 翻译：获取后将英文标题翻译为中文，保留原标题
- 时效控制：仅保留 `pubDate` 为配置时区下「当天」的新闻
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

### 4) 生成静态页面

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

获取源由 `sources.yaml` 驱动。当前仓库示例包含：

- AP News
- AP Top News
- Reuters World News（RSS）
- Guardian World（RSS）
- Google News（RSS）
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

- `timezone`：业务时区（[IANA 时区名](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)，如 `Asia/Shanghai`）。用于 `pause_time_ranges` 的钟点、「仅当日」筛选、`data/news-days.json` 的日期键、新闻保留清理的日期边界。留空或无效值时回退为运行环境的系统本地时区。环境变量 `NEWS_TIMEZONE` 可覆盖此项（例如在 CI 与本地共用同一仓库时显式指定）。
- `fetch_interval_minutes`：自动获取间隔（分钟）
- `min_fetch_interval_minutes`：手动/自动获取最短间隔（分钟）
- `request_timeout_seconds`：单请求超时（秒）
- `pause_time_ranges`：暂停时间段（格式 `时-分 to 时-分`，支持跨天；钟点按 `timezone` 解释）
- `news_retention.cleanup_interval_days`：每多少天清理一次新闻（保留最近 N 天）
- `news_retention.archive_on_cleanup`：清理时是否归档被清理新闻
- `ai_translation.*`：翻译开关、批量大小、超时、请求头等（不含 key）
- `push.*`：推送开关、重复间隔、黑名单、消息长度上限等
- `ui.poll_interval_seconds`：前端轮询间隔

## 环境变量（`.env`）

- `NEWS_TIMEZONE`：可选，覆盖 `setting.yaml` 中的 `timezone`（IANA 名称）
- `ANTHROPIC_API_KEY`：AI 翻译 API Key（必填，启用翻译时）
- `ANTHROPIC_API_URL`：Anthropic Messages 兼容接口地址
- `ANTHROPIC_MODEL`：模型名
- `DAY_APP_PUSH_URL`：day.app 推送地址（可选）
- `NTFY_PUSH_URL`：ntfy 推送地址（可选）
- `PORT`：本地服务端口（默认 5178）

## 源连通性测试（支持代理）

可以不启动服务，单独测试所有源连接状态：

```bash
npm run test:sources
```

若需代理，请在项目根目录新建 `proxy.local.json`（该文件已加入 `.gitignore`，不会上传）：

```json
{
  "http": "http://127.0.0.1:7897",
  "https": "http://127.0.0.1:7897"
}
```

可直接复制 `proxy.local.example.json` 后改名为 `proxy.local.json` 使用。

## 清空归档新闻

```bash
npm run archive:clear
```

该命令会清空归档文件中的全部新闻记录。

## 获取与推送行为细节

### 时区（`timezone` / `NEWS_TIMEZONE`）

GitHub Actions 等 Linux 环境默认系统时区多为 **UTC**，若依赖「系统本地」而不配置 `timezone`，容易出现与你在 Windows/macOS 上本地运行时不一致的情况（例如同一 `pause_time_ranges` 命中窗口不同、或「当天」判定不同）。

建议在 `setting.yaml` 中设置 `timezone`（例如 `Asia/Shanghai`），或在 CI 的 Secrets/Variables 中通过环境变量 `NEWS_TIMEZONE` 注入相同值，使本地与 Action 行为一致。

### 仅保留当日新闻

获取后会检查每条新闻的 `pubDate`：

- 无 `pubDate` 或无法解析：过滤
- `pubDate` 在配置的 `timezone` 下非「当天」：过滤

被过滤数量会体现在状态里（`filteredOutByDateCount`）。  
同一天内已抓取过的新闻不会重复参与“新增处理/推送”，但页面会展示“当天累计全部新闻”。

### 关键词命中规则

- 匹配范围仅标题（含翻译后标题），不再匹配 URL
- 英文关键词（如 `AI`）按“完整词”匹配，减少误命中（如 `detail`）

### 推送拆分与长度控制

- 先按 `push.max_message_chars`（默认 4096）构建消息
- day.app 额外按最终 URL 长度控制（内部保护），超长会截断并重试
- 同一条重点内容根据 `push.repeat_interval_minutes` 去重

## 本地 API

- `GET /api/state`：当前状态与新闻列表
- `GET /api/archive`：归档新闻列表
- `POST /api/refresh`：手动触发获取
  - 可能返回 `429`（最小间隔限制）
  - 可能返回 `423`（命中暂停时间段）

## 归档页面

- 本地运行：`/archive.html`
- GitHub Pages：`docs/archive.html`

支持按日期与标签双重筛选。

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

## 服务器运行

本项目也可以直接在部署在服务器运行。

### 最小部署步骤

1. 安装 Node.js（建议 20+）
2. 拉取项目代码并安装依赖：

```bash
npm ci
```

3. 配置环境变量（`.env`，参考 `.env.example`）  
4. 启动服务：

```bash
npm start
```

默认端口为 `5178`，可通过环境变量覆盖：

```bash
PORT=8080 npm start
```

### 使用 PM2 守护（推荐）

```bash
npm install -g pm2
pm2 start npm --name newslive -- start
pm2 save
pm2 startup
```

常用命令：

```bash
pm2 status
pm2 logs newslive
pm2 restart newslive
```

### systemd（可选）

若不用 PM2，也可用 systemd 守护 `node src/server.js`。  
建议在 service 中设置 `WorkingDirectory` 为项目目录，并加载 `.env` 变量。

## 目录结构（关键文件）

- `src/server.js`：本地服务与 API
- `src/crawler.js`：获取编排、过滤、翻译、推送、状态管理
- `src/sources.js`：多类型获取器实现
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
