# Hoshino R2

Cloudflare Worker 上的多桶 R2 / S3-compatible 文件管理器（优先适配腾讯云 COS）。网页和命令行共用 `/api/v1`，通过 Cloudflare Access 统一鉴权。

## 功能

- R2 与外部 S3-compatible 桶并列挂载，多桶切换、目录浏览、前缀筛选、递归列举、游标分页和元数据。
- Mantine 控制台 UI：深浅主题（默认跟随系统、记忆选择）、响应式存储桶导航、文件操作菜单、详情抽屉、删除/覆盖确认弹窗和传输任务面板。
- 普通下载及标准单段 HTTP Range 下载，支持 ETag 条件读取。
- 网页分片下载：进度、平均速度、暂停/继续、自动重试、取消，按偏移写入本地文件。
- 小文件 PUT、大文件 multipart 上传；单个/批量删除和逐项错误提示。
- 文件菜单提供 aria2 命令；CLI 支持桶清单、列举、元数据、上传、下载、续传、删除和取消上传。
- 全部部署配置使用 TOML，fork 专属 override 与公共配置分离。

所有经过 Access 授权的身份拥有全部挂载桶的读写权限。

## 网页界面

前端采用 React + Mantine 9、CSS Modules 和 Lucide 图标。右上角提供 OpenAPI 文档链接、传输设置弹窗、主题选择和账户菜单。点击设置图标打开 Modal，调整分片大小和下载并发；修改立即生效于新任务，关闭弹窗后保留当前页面内的设置。鉴权状态显示在账户菜单中。

侧栏仅用于存储桶选择，隐藏滚动条但支持滚轮、触摸和键盘导航。移动端通过左上角导航按钮打开桶列表，设置与文档仍从右上角访问。

设置弹窗内分片大小和下载并发都用滑块调整：分片大小的 8/16/32/64 MiB 档位等距排列，下载并发提供 1/2/4/6 路；支持拖动和键盘方向键、Home/End 操作。

文件名打开详情抽屉，可直接普通下载、启动分片下载或打开 aria2/curl 下载命令；每行的“下载”默认使用浏览器普通下载，“更多操作”菜单包含分片下载、aria2/curl 命令及删除。勾选文件后显示低强调的批量操作栏，仍可取消选择或删除所选。前缀筛选按对象 KEY 的开头匹配，递归开关列举该前缀下的所有层级。列表统计仅包含已加载文件。

`web/main.tsx` 配置主题与 Provider，`web/App.tsx` 管理应用状态，`web/components/` 存放文件列表、详情/命令弹窗、异步确认和传输面板。`web/App.module.css` 提供布局与局部样式。

Worker 为每个响应生成独立的样式 nonce，并在 HTML 的 `<head>` 中注入 `style-nonce` 元数据；前端将 nonce 传给 Mantine 和弹窗滚动锁定组件。CSP 仅允许本站脚本与样式，以及携带对应 nonce 的样式标签，不启用 `unsafe-inline`。

## 本地运行

需要 Node.js 22.12 或更新版本。

```bash
npm ci
npm run dev
```

打开 `http://localhost:8787`。没有 `deploy.override.toml` 时自动提供两个本地桶；本地 R2 数据存储在 `.wrangler/`，不会访问远端桶。如果配置了 S3/COS 挂载，本地开发也会请求指定的外部 endpoint，需提供本地 secret。网页由 Vite 构建后交给 Wrangler；修改网页后重启 `npm run dev`，Worker 源码由 Wrangler 监听。

`dev` 只允许本地运行，自动生成 `LOCAL_DEV = "true"`；Worker 仅对 localhost / 127.0.0.1 / ::1 请求启用开发身份。部署命令生成 `LOCAL_DEV = "false"`。不要直接部署本地生成文件。

## Fork 配置与部署

将 `deploy.override.example.toml` 复制为 `deploy.override.toml`，填写账户、域名、Access 和实际桶信息。此文件可以提交到各自 fork，便于从上游同步代码；不要写入任何认证凭据。

```toml
[worker]
name = "my-r2-web"
account_id = "填写32位账户ID"
workers_dev = false
preview_urls = false

[[worker.routes]]
pattern = "files.example.com"
custom_domain = true

[access]
team_domain = "https://my-team.cloudflareaccess.com"
audience = "填写64位Access应用AUD"

[[buckets]]
id = "documents"
label = "文档"
binding = "R2_DOCUMENTS"
bucket_name = "my-documents"
# jurisdiction = "eu"
```

- `[worker]` 覆盖 `wrangler.toml` 中的公共配置；标量替换、普通表按字段合并、数组/数组表整体替换。
- `[[buckets]]` 同时生成 `r2_buckets` 和应用桶映射。Worker 按 binding 动态访问；API 使用稳定的 `id`。
- `[[buckets]]` 不写 `type` 时沿用 R2；`type = "s3"` 时只生成应用桶映射，不创建 R2 binding。R2 与 S3 桶 ID 必须唯一，可只配置 S3 桶。
- `ASSETS`、`BUCKETS`、`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、`LOCAL_DEV` 是保留名称。
- 生成脚本验证账户/AUD、域名、桶 ID 和 binding，并拒绝命名 Wrangler env。不同部署使用不同 override 文件。
- 静态资源必须 `run_worker_first = true`，确保网页和 API 都经过 JWT 验证。禁用 workers.dev 和预览 URL。
- `wrangler.generated.toml` 放在根目录以保持相对路径，已加入 `.gitignore`。不要手工维护它。

### 外部 S3 / 腾讯云 COS 挂载

在同一份 override 中加入一个或多个桶。腾讯 COS 示例（`bucket_name` 必须含 APPID，endpoint 为**地域服务地址**，不含桶名）：

```toml
[[buckets]]
id = "cos"
label = "腾讯 COS"
type = "s3"
provider = "cos"
bucket_name = "pictures-1250000000"
endpoint = "https://cos.ap-guangzhou.myqcloud.com"
region = "ap-guangzhou"
addressing = "virtual"
access_key_id_secret = "COS_SECRET_ID"
secret_access_key_secret = "COS_SECRET_KEY"
```

`provider = "cos"` 使用 COS 的 XML API 签名；通用 S3 使用 `provider = "s3"`（SigV4），按服务要求选择 `addressing = "virtual"`（桶名前置主机名）或 `"path"`（桶名作为路径首段）。例如 AWS S3 可使用 `endpoint = "https://s3.us-east-1.amazonaws.com"`、`region = "us-east-1"`、`addressing = "virtual"`。只接受 HTTPS endpoint，不接受 URL 中的用户名、查询、路径或片段；本地开发可使用 `http://localhost:9000` 等 loopback endpoint。需要临时凭据时可额外配置 `session_token_secret = "S3_SESSION_TOKEN"`，COS 使用 `x-cos-security-token`，通用 S3 使用 SigV4 session token。

配置中的 `*_secret` 是 **Worker secret 的变量名**，不要将 SecretId / SecretKey 明文写入 TOML 或 `[worker.vars]`。本地在根目录创建已忽略的 `.dev.vars`：

```dotenv
COS_SECRET_ID="填写SecretId"
COS_SECRET_KEY="填写SecretKey"
```

部署时，在目标 Worker 的 Cloudflare 控制台 **Settings → Variables and Secrets** 创建同名 Secret；或生成配置后用 `npx wrangler secret put COS_SECRET_ID --config wrangler.generated.toml`、`npx wrangler secret put COS_SECRET_KEY --config wrangler.generated.toml` 设置（Wrangler 的 `secret put` 会立即部署 Worker 新版本）。部署工作流会沿用 Worker 上现有的 secrets；缺少 secret 的桶会返回 `503 storage_not_configured`。为 COS 凭据授权该桶的列举、读取、写入、删除和 multipart 操作。

挂载显示在同一个桶列表，网页和 CLI 继续使用其 `id` 操作，无需客户端直连存储。S3/COS 对象 key 不能包含独立的 `.` 或 `..` 路径段，以避免 URL 路径归一化越过桶名。COS 的 `If-None-Match: *` PUT 使用 `x-cos-forbid-overwrite`（仅在**未启用版本控制**的桶上生效）；其他 COS PUT 条件头返回 501。multipart 的存在性检查与完成间仍有覆盖窗口；不同服务对 ETag 和上传限制可能另有约束。

### Cloudflare 设置

1. 为 R2 挂载在同一账户中创建 R2 桶；域名的 zone 也属于 Worker 账户。外部 COS/S3 桶在相应服务创建。
2. 创建覆盖 **整个 hostname** 的 self-hosted Access Application，例如 `files.example.com`，不只保护 `/api`。
3. 添加允许用户登录的 **Allow** policy。
4. 创建 Access Service Token，并添加允许该 token 的 **Service Auth** policy，供 CLI/curl/aria2 使用。每次请求都发送两项 token 请求头。
5. 从 Access Application 获取 AUD，从 Zero Trust 获取 team domain，填写 override。
6. 使用 `npx wrangler login` 登录，或在部署环境设置 `CLOUDFLARE_API_TOKEN`。部署 token 需要 Workers 脚本写入、R2 访问和相应自定义域名/zone 权限。

```bash
npm run deploy -- --dry-run
npm run deploy
# 选择其他账户的配置
npm run deploy -- --override configs/account-b.toml
```

`deploy` 会先生成配置并构建网页，再执行 Wrangler。`npm run config` 仅生成部署配置；`npm run config -- --local` 生成本地配置。CI 在各 fork 注入自己的 Cloudflare API Token，执行 `npm ci` 和同样的部署命令。

仓库的检查和部署工作流均手动触发，不会在 push 或 PR 时自动运行。需要验证时，在 GitHub Actions 页面选择 **Checks → Run workflow**，运行类型检查、Node/UI 测试及部署 dry-run。部署工作流默认读取 fork 的 `deploy.override.toml`；在该 fork 的 Actions secrets 中配置 `CLOUDFLARE_API_TOKEN` 后，可在 Actions 页面触发，并选择其他 override 路径。

Access Application 和 policies 由 Cloudflare 管理，本项目不自动创建。Worker 再验证 Access JWT 的 RS256 签名、issuer、audience、exp 和 iat，通过缓存 JWKS 支持密钥轮换。API 不启用跨域 CORS，修改请求会校验 Origin。

## 网页传输

### 下载

支持 `showSaveFilePicker` 的桌面浏览器（如 Chrome/Edge）可先选保存位置，然后分片下载。默认 16 MiB、4 路并发，可选择 8/16/32/64 MiB 和 1/2/4/6 路。每片使用 `If-Match` 固定 ETag，并检查 206、Content-Range、Content-Length 和 ETag；写入队列按偏移串行写入。

内存只保留有限个分片，不拼接全文件 Blob。文件系统接口通常写入临时文件，完成并关闭写入流后才提交最终文件；取消会丢弃临时写入。暂停不取消正在进行的分片，恢复后继续剩余分片。

网页任务只支持当前页面会话内继续；关闭/刷新页面后需要重启任务。浏览器不支持文件选择落盘接口时提供普通下载和 aria2 命令。普通下载使用浏览器下载器，不把全文件放入网页内存。

对象下载始终作为二进制附件，不在应用域名内执行上传的 HTML/SVG。ETag 是对象标识，multipart ETag 不是整文件 MD5。

### 上传

点击“上传文件”选择一个或多个文件后，在弹窗中确认目标路径前缀和最终存储路径，再点击“开始上传”。前缀默认使用当前浏览位置，可改为桶内其他路径；从桶根目录起算，留空上传到根目录，非空且末尾没有 `/` 时自动补上。例如前缀 `backups/2026` 与文件 `photo.jpg` 组成 `backups/2026/photo.jpg`。多个文件共用前缀并保留原文件名，无需预先创建目录；上传目标不会改变当前浏览位置。最终路径不能包含 NUL，且最多为 1024 个 UTF-8 字节。

小于等于所选分片大小的文件使用 PUT，其他文件使用 multipart，默认 16 MiB、3 路并发。已完成分片保存在当前任务内，失败重试不重传成功分片；取消调用 abort。上传成功后自动刷新当前可见存储桶的列表；若已切到其他存储桶，则不刷新无关列表，下次切回时正常加载。完成的传输任务保留固定的平均速度，不再随页面计时降低。

创建上传会话和完成上传不自动重试，因为响应丢失时服务端可能已成功。完成响应丢失后先检查远端元数据，再决定重试或重新上传。关闭页面可能留下未完成上传；R2 默认 7 天清理，S3/COS 请自行配置未完成 multipart 的清理规则。网页覆盖前提示，但多人并发时检查和完成之间仍可能被其他用户写入；最后完成的 multipart 覆盖同名对象。

每次请求最多 **64 MiB**，低于常见 Cloudflare 100 MB 请求上限；multipart 非末尾分片必须等长且至少 5 MiB，最多 10,000 片。因此默认 16 MiB 上传上限约 156.25 GiB，选择 64 MiB 可达 625 GiB。本项目首版不支持完整 5 TiB R2 单对象上传上限。

## 命令行

设置环境变量（示例中的值需替换；不要将凭据提交到 Git）：

```bash
export R2_APP_URL='https://files.example.com'
export CF_ACCESS_CLIENT_ID='your-service-token-client-id'
export CF_ACCESS_CLIENT_SECRET='your-service-token-client-secret'

npm run cli -- buckets
npm run cli -- ls documents 'backups/' --all
npm run cli -- ls documents '' --flat --all
npm run cli -- stat documents 'backups/large.bin'
npm run cli -- download documents 'backups/large.bin' ./large.bin
npm run cli -- upload documents 'backups/large.bin' ./large.bin --overwrite
npm run cli -- abort documents 'backups/large.bin' ./large.bin
npm run cli -- rm documents 'backups/large.bin'
```

本地使用 `R2_APP_URL=http://localhost:8787`，无需 Access 凭据。CLI 仅依赖 Node 标准库，可单独复制 `scripts/cli.mjs`，用 `node cli.mjs ...` 执行。需要纯 JSON 输出时优先直接运行脚本，避免 npm 的命令提示。

- 下载写入 `FILE.part`，使用 `FILE.download.json` 保存 ETag、已完成分片及 SHA-256；重新执行相同命令自动继续，并重新校验磁盘已完成分片。对象 ETag 变化则拒绝续传。
- 上传使用 `FILE.upload.json` 保存会话与分片 ETag。每次启动流式计算整个源文件 SHA-256，避免续传混入已改变的源文件；传输期间也不应修改源文件。
- Ctrl+C 保留 sidecar 和未完成上传，下次可恢复，或用 `abort` 清理上传。
- sidecar 原子替换，权限 0600，不保存凭据。不要并发运行多个命令处理同一本地文件或相同 sidecar。
- 文件/对象已有内容默认拒绝覆盖，使用 `--overwrite` 明确允许。multipart 的存在性检查不是原子条件写入，仍有并发覆盖窗口。
- CLI 默认 16 MiB、4 并发；可使用 `--part-size 64 --concurrency 3`。恢复时沿用 sidecar 保存的分片大小。
- 服务端/网络临时错误最多自动重试 3 次。下载响应中途断开时重新执行命令继续；完成上传响应丢失仅在远端 multipart ETag 与本地 MD5 推算值吻合时自动认定成功。COS/S3 的加密或服务实现可能返回不同 ETag，此时保留 sidecar 并报错，需要手工核对对象内容，不会盲目重传完成请求。

### curl 与 aria2

```bash
curl --fail --show-error \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  "$R2_APP_URL/api/v1/buckets"

# 使用 --data-urlencode 正确处理中文、空格、+、#、% 等对象名
curl --fail --show-error --get \
  --data-urlencode 'key=目录/文件 + #%.bin' \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H 'Range: bytes=0-16777215' \
  --output first-part.bin \
  "$R2_APP_URL/api/v1/buckets/documents/object"
```

网页可复制带正确 URL 编码和 shell 引号的 aria2 命令。curl/aria2 普通续传不会自动固定历史 ETag；只有确认对象未变化才续传，或使用本项目 CLI。不要给认证请求添加自动跟随外域重定向参数。

## API

机器可读文档：`GET /api/v1/openapi.json`（也受 Access 保护）。

| 路径（前缀 `/api/v1`） | 方法 | 用途 |
|---|---|---|
| `/buckets` | GET | 桶清单、身份、上传限制 |
| `/buckets/:id/objects` | GET | prefix/delimiter/cursor/limit 分页 |
| `/buckets/:id/metadata?key=…` | GET | 元数据 |
| `/buckets/:id/object?key=…` | GET/HEAD | 流式/Range 下载及响应头 |
| `/buckets/:id/object?key=…` | PUT/DELETE | 上传或删除 |
| `/buckets/:id/uploads` | POST | 创建：`{key,size,partSize?,contentType?}` |
| `/buckets/:id/uploads/:uploadId/parts/:number?key=…` | PUT | 原始分片内容；返回 `{partNumber,etag}` |
| `/buckets/:id/uploads/:uploadId/complete?key=…` | POST | 完成：`{parts:[{partNumber,etag},…]}` |
| `/buckets/:id/uploads/:uploadId?key=…` | DELETE | 取消上传 |

Range 支持 `bytes=start-end`、`bytes=start-`、`bytes=-suffix`；不支持多段 ranges，无效范围返回 416 及 `Content-Range: bytes */size`。HEAD 忽略 Range。GET 支持 If-Match、If-None-Match、If-Range，If-Range 不匹配则完整返回 200。R2 / S3 head/get 之间通过 ETag 与上游响应校验固定版本；并发对象变化返回 412。R2 PUT 支持条件头；COS 条件限制见上文。PUT/分片上传需要 Content-Length。

错误格式：`{"error":{"code":"invalid_request","message":"…"}}`。Access 拒绝请求时可能在请求到达 Worker 前返回自身 HTML/重定向；命令行需配置 Service Auth。

## 验证

```bash
npm run typecheck
npm run build
npm test
# 首次运行浏览器测试，安装 Chromium（Linux 缺依赖时添加 --with-deps）
npx playwright install chromium
npm run test:ui
```

测试使用 Miniflare 的真实本地 R2 binding 和模拟的 S3/COS 上游，覆盖签名、Range、条件读取、特殊 key、分页、多桶、multipart 和 CLI 传输；还包括 TOML 合并校验和 JWT 验证。模拟测试不代表真实 COS 已验收；需用实际 COS 凭据验证不同地域、桶版本控制与大文件行为。

Playwright 测试自动通过合成 TOML fixture 在 `127.0.0.1:8790` 启动本地 Worker，使用真实构建页面/CSP 和模拟对象 API 验证主题、菜单、焦点返回、复制命令、删除/覆盖确认、上传任务、移动端布局及下载控制。文件保存接口以模拟写入器验证点击手势和写入偏移；真实系统保存对话框仍需在 Chrome/Edge 手工验收。请串行运行 `npm test` 和 `npm run test:ui`，两者都会生成本地配置及构建产物。
