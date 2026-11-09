# NewsLive

NewsLive 是一个可本地运行、可自动化部署到 GitHub Pages 的新闻聚合工具。  
它支持多源获取、国内实时榜单、关注主题筛选与推送、标题翻译（默认 Google 免费接口，DeepSeek 为备选）以及“仅保留当日新闻”的时效过滤。

## 核心能力

- 多源获取：支持 `html_links`、`rss`、`json_items`、`markdown_link_pages`
- 国内榜单：微博、抖音、Bilibili 独立页面；每次抓取更新快照，每天 12:00 / 20:00 各推送一次
- 关注主题：每个主题拥有名称、开关、推送策略和一组中英文匹配词
- 标题翻译：获取后将英文标题翻译为中文，保留原标题
- 时效控制：仅保留 `pubDate` 为配置时区下「当天」的新闻
- 事件聚合：归一化链接与标题，将多来源重复报道合并为一个事件
- 可靠推送：持久化待发送队列 + Bark/ntfy 分渠道投递账本，失败渠道单独重试
- 推送静默：静默时段继续获取和入库，结束后自动补发队列
- 推送拆包：同一事件只推送一次；按消息体积拆分，day.app 额外做 URL 长度保护
- 双形态页面：
  - 本地动态页面：`public/index.html` + `/api/state`
  - 静态页面产物：今日新闻、实时榜单、新闻归档

## 技术栈

- Node.js `>=20`
- Express
- Cheerio
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
# 默认 Google 翻译无需密钥
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

仅调整网页模板或样式、不重新抓取新闻时，可使用：

```bash
npm run build:ui
```

该命令会读取 `data/news-days.json`、`data/news-archive.json` 与 `data/rankings.json`，结合已有静态状态重新生成页面、JSON 和共享主题样式，不会触发抓取、翻译或推送。

## 配置说明

### `topics.yaml`

- `name`：页面与推送显示的主题名称
- `enabled`：是否参与匹配和页面筛选
- `push`：命中主题后是否进入实时推送队列
- `keywords`：主题下的一组匹配词，用户无需为同一主题维护多个筛选按钮

示例：

```yaml
topics:
  - id: ai-agents
    name: AI 与 Agent
    enabled: true
    push: true
    keywords:
      - AI
      - Agent
```

### `sources.yaml`

获取源由 `sources.yaml` 驱动。当前包含中国新闻网综合、财经、体育，以及 AP、Reuters、Guardian、Google News、ProPublica、Hacker News 与 Lobsters 等来源。

支持类型与常用字段：

- `html_links`
  - `url` `min_title_length` `max_items`
- `rss`
  - 自动抽取 `title` / `link` / `pubDate`（含部分兼容字段）
- `json_items`
  - `items_path` `title_path(s)` `url_path(s)` `id_path(s)` `date_path(s)` `url_template` `method`
- `markdown_link_pages`
  - 从 markdown 提取链接后回抓页面标题

### `setting.yaml`

非敏感配置放在 `setting.yaml`，敏感配置放在 `.env`。

主要配置项：

- `timezone`：业务时区（[IANA 时区名](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)，如 `Asia/Shanghai`）。用于推送静默时段、「仅当日」筛选、`data/news-days.json` 的日期键、新闻保留清理的日期边界。留空或无效值时回退为运行环境的系统本地时区。环境变量 `NEWS_TIMEZONE` 可覆盖此项。
- `fetch_interval_minutes`：自动获取间隔（分钟）
- `min_fetch_interval_minutes`：手动/自动获取最短间隔（分钟）
- `request_timeout_seconds`：单请求超时（秒）
- `news_retention.cleanup_interval_days`：每多少天清理一次新闻（保留最近 N 天）
- `news_retention.archive_on_cleanup`：清理时是否归档被清理新闻
- `news_retention.archive_retention_days`：归档列表保留最近多少天（默认 7）；`<=0` 时不按时间删除归档记录
- `ai_translation.*`：翻译开关、服务选择（`provider: google` / `deepseek`）、批量大小、超时等（不含 key）；接口格式、思考模式和额外请求头仅用于 DeepSeek
- `push.quiet_time_ranges`：仅暂停发送的静默时段（格式 `时-分 to 时-分`，支持跨天）；获取、翻译和入库照常进行
- `push.source_blacklist`：来源黑名单；多来源事件仅在所有来源都命中黑名单时不推送
- `push.max_items_per_push` / `push.max_message_chars`：单次推送条数和消息大小，默认最多 20 条且不超过 4096 字节
- `push.delivery_ledger_retention_days`：分渠道投递账本保留天数
- `rankings.*`：公开榜单接口、每个平台保留条数与请求超时
- `rankings.push.times`：榜单每日推送时刻，默认 `12:00` / `20:00`
- `rankings.push.items_per_platform`：每个平台推送条数，默认 3 条
- `rankings.push.window_minutes`：定时任务错过整点后允许补发的时间窗口
- `ui.poll_interval_seconds`：前端轮询间隔

## 环境变量（`.env`）

- `NEWS_TIMEZONE`：可选，覆盖 `setting.yaml` 中的 `timezone`（IANA 名称）
- `RANKINGS_API_URL`：可选，覆盖公开榜单兼容接口地址
- `TRANSLATION_PROVIDER`：可选，覆盖 `ai_translation.provider`；默认 `google`，设置为 `deepseek` 可手动切换备选
- `DEEPSEEK_API_KEY`：DeepSeek API Key（仅选择 `deepseek` 时必填）
- `DEEPSEEK_API_URL`：接口地址；默认 `https://api.deepseek.com/chat/completions`，也可填写基础地址 `https://api.deepseek.com`
- `DEEPSEEK_MODEL`：模型名；默认 `deepseek-v4-flash`，也可使用 `deepseek-v4-pro`
- `DEEPSEEK_THINKING_MODE`：可选，`enabled` / `disabled`；翻译默认 `disabled`
- `AI_API_FORMAT`：可选，`openai` / `anthropic`；不设置时根据 URL 自动识别

Google 使用 `https://translate.googleapis.com/translate_a/single`（`client=gtx`），自动识别源语言并翻译为简体中文，无需 API Key。每个标题独立请求，`batch_size` 控制每批并发数，`max_items_per_run` 限制每轮条数。单条失败时保留原标题并记录错误，其他标题继续翻译，不会自动切换 DeepSeek。该免费网页接口可能限流或变更，相关说明见 [Google 开发者论坛](https://discuss.google.dev/t/translate-googleapis-com-translate-a/126639)。

切换到 DeepSeek 时，旧的 `ANTHROPIC_API_KEY`、`ANTHROPIC_API_URL`、`ANTHROPIC_MODEL` 仍可作为兼容回退。若旧模型名为 `deepseek-chat` 或 `deepseek-reasoner`，DeepSeek 接口会自动迁移为 `deepseek-v4-flash`；已有 DeepSeek 密钥不会改变默认 Google 服务。
- `DAY_APP_PUSH_URL`：Bark / day.app 推送地址（可选）
- `NTFY_PUSH_URL`：ntfy 推送地址（可选）
- `NTFY_BEARER_TOKEN`：ntfy `Authorization: Bearer`（可选，私有主题等）
- `PORT`：本地服务端口（默认 5178）
- `HOST`：监听地址（默认 `127.0.0.1`，避免无意间暴露管理接口）
- `NEWSLIVE_ADMIN_TOKEN`：非回环地址监听时必填；调用 `POST /api/refresh` 时使用 `Authorization: Bearer <token>`

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

GitHub Actions 等 Linux 环境默认系统时区多为 **UTC**，若依赖「系统本地」而不配置 `timezone`，容易出现与你在 Windows/macOS 上本地运行时不一致的情况（例如同一推送静默窗口命中时间不同、或「当天」判定不同）。

建议在 `setting.yaml` 中设置 `timezone`（例如 `Asia/Shanghai`），或在 CI 的 Secrets/Variables 中通过环境变量 `NEWS_TIMEZONE` 注入相同值，使本地与 Action 行为一致。

### 仅保留当日新闻

获取后会检查每条新闻的 `pubDate`：

- 无 `pubDate` 或无法解析：过滤
- `pubDate` 在配置的 `timezone` 下非「当天」：过滤

被过滤数量会体现在状态里（`filteredOutByDateCount`）。  
同一天内已抓取过的事件不会重复参与“新增处理/推送”，但页面会展示“当天累计全部事件”。相同规范链接或高度相似标题会聚合，卡片会显示来源数量，并可展开其他报道链接。

来源只有在至少返回一条带有效发布时间的内容时才会标记为“连接正常”；短暂网络错误和常见临时 HTTP 错误会自动重试一次。已有事件的中文标题会在事件聚合后直接复用，不会在每轮获取时重复调用翻译接口。

### 关键词命中规则

- 匹配范围仅标题（含翻译后标题），不再匹配 URL
- 英文关键词（如 `AI`）按“完整词”匹配，减少误命中（如 `detail`）

### 推送队列、去重与长度控制

- 先按 `push.max_message_chars`（默认 4096）构建消息
- Bark/day.app 使用 POST JSON 的 `markdown` 正文，首行格式为 `[新闻来源] [标题超链接]`
- Bark 重点新闻按完整 JSON 大小（含 `body`、`markdown`、标题与分组）拆包，并为 APNs 封装预留空间；单条仍超限则保留失败记录，不截断原文链接或误记成功
- Bark 失败会保留 HTTP 状态和可识别的 APNs 错误类型（如 `PayloadTooLarge`），不将含设备密钥的原始响应发布到页面
- ntfy 使用相同的 Markdown 正文格式，只在新闻标题上保留原文超链接，避免客户端额外显示重复链接
- ntfy 重点新闻按 UTF-8 字节数拆分，正文硬上限 4096 字节（即使配置更大也不突破），标题上限 1024 字节；热榜共用发送前校验，避免超限正文被服务端转成附件
- 单条新闻超限时保留失败记录并继续发送后续正常新闻，不截断标题超链接；整份热榜超限时记录失败，不发送残缺正文
- 时间压缩为 `月-日 时:分`，多来源显示为“首个来源 等 N 个来源”
- 仅旧的 `{title}` / `{body}` 自定义 URL 模板继续使用 GET，并保留 URL 长度保护
- 同一事件即使命中多个重点关键词，也只进入队列一次
- `data/news-days.json` 会保存最近一次成功抓取时间；重启后只补这个断点之后发布的新事件，首次建立数据基线时不会集中推送当天旧闻
- `data/push-queue.json` 保存尚未完成全部目标渠道投递的事件
- 待推送队列只保留业务时区下当天发布的新闻，每轮清理更早的记录；跨日旧闻不补发，新闻归档不受此规则影响
- `data/push-delivery.json` 分别记录 Bark 与 ntfy 的尝试次数、成功时间和最近错误
- 某个渠道成功不会掩盖另一个渠道的失败；重试时不会再次发送已成功的渠道
- 静默时段内重点事件持续入队，静默结束后的下一轮获取会发送仍属于当天的新闻
- 榜单推送独立按“日期 + 时刻 + 渠道”记账，失败渠道可重试，成功渠道不会重复发送
- 榜单正文同样采用 `[平台] [标题超链接]`，不额外附加裸链接

## 本地 API

- `GET /api/state`：当前状态与新闻列表
- `GET /api/meta`：前端轮询用的轻量版本与状态摘要
- `GET /api/archive`：归档新闻列表
- `GET /api/rankings`：微博、抖音、Bilibili 榜单快照
- `POST /api/refresh`：手动触发获取
  - 可能返回 `429`（最小间隔限制）

## 归档页面

- 本地运行：`/archive.html`
- GitHub Pages：`docs/archive.html`

支持实时搜索新闻标题（含已保存的原文及关联报道标题），忽略英文大小写，并可同时按日期与标签筛选。

## 实时榜单页面

- 本地运行：`/rankings.html`
- GitHub Pages：`docs/rankings.html`

页面支持综合/单平台切换，并显示上游更新时间和排名变化。榜单只保存当前快照与上次排名，不保存无限历史。

## GitHub Actions 与 Pages

主工作流：`.github/workflows/newslive-pages.yml`

计划在每小时第 07、37 分钟执行，避开整点高峰。GitHub Actions 的定时事件可能延迟或被跳过，页面显示的 30 分钟间隔不代表实际触发保证；需要稳定间隔时，应使用下文的常驻服务器部署。

流程：

1. 定时/手动触发
2. `npm ci`（无需安装 Chromium）
3. 执行 `npm run build:pages`
4. 自动提交 `docs/`、新闻数据、推送队列与分渠道投递账本
5. 发布到 GitHub Pages

手动运行时勾选 `ui_only` 可仅重建并发布网页（如归档搜索、样式更新），读取现有新闻数据，不触发抓取、翻译、通知推送或 Git 历史清理。

在 **Actions → Secrets and variables** 中配置。推送 URL 包含设备 key/topic，必须放在 **Secrets**，不要存入明文 Variables：

- `DAY_APP_PUSH_URL`（Bark / day.app，形如 `https://api.day.app/<你的 key>/`）
- `NTFY_PUSH_URL`（可选）
- `NTFY_BEARER_TOKEN`（可选，私有 ntfy 等需 Bearer 时）
- `DEEPSEEK_API_KEY`（仅选择 DeepSeek 备选时必填）
- `DEEPSEEK_API_URL`（例如 `https://api.deepseek.com/chat/completions`）
- `DEEPSEEK_MODEL`（推荐 `deepseek-v4-flash`）

默认 Google 翻译无需设置翻译相关 Secrets。需要切换 DeepSeek 时，在仓库 Variables 中设置 `TRANSLATION_PROVIDER=deepseek` 并配置上述密钥。工作流也会读取旧的 `ANTHROPIC_*` Secrets，供 DeepSeek 备选使用。

CI 会一并提交 `data/news-days.json`、`data/push-queue.json`、`data/push-delivery.json` 与 `data/rankings.json`，保持事件去重、静默补发、榜单定时推送和各渠道投递状态连续。

### 自动清理 Git 提交历史

同一工作流每天北京时间 **03:17** 单独执行历史清理；在默认分支手动运行工作流时，也会在页面部署成功后清理。定时清理不触发新闻抓取或推送，与页面任务共用并发锁。

`scripts/prune-history.js` 按提交者时间保留默认分支最近 **30 × 24 小时**的提交（含边界），移除更早的提交记录。保留近期提交的作者、时间、消息及文件快照，并连接移除旧提交后剩余的父子/合并关系；若最新提交也已过期，则生成一个当前文件快照提交。当前源码、新闻归档和推送账本内容不变，其他分支、标签及 Actions 运行记录不在清理范围内。

清理使用完整历史，并在校验当前文件树和保留提交数量后，通过带明确旧 SHA 的 `--force-with-lease` 推送。若运行期间远端分支已更新，任务会失败并留待下一轮处理，不会覆盖新提交。没有过期记录时跳过重写。

**此功能会重写提交 SHA，重写后的签名会被移除。** 默认分支的保护规则必须允许 Actions 身份强制推送，否则清理会失败；脚本不会自动放宽仓库保护。协作者应先保存本地改动，再重新克隆或将工作迁移到新的远端历史，避免合并旧历史把已清理记录带回来。旧对象可能仍被其他分支、标签或 GitHub 内部引用保留，远端空间释放由 GitHub 回收机制决定，不保证立即缩小仓库。

本地预演（只写入新 Git 对象，不改分支、工作文件或远端）：

```bash
node scripts/prune-history.js
```

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
- `src/ai-translate.js`：Google 免费标题翻译及 DeepSeek 备选客户端（兼容 Anthropic 格式）
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
