# 月下集代码与 OpenClaw 接入说明

检查日期：2026-10-02（Asia/Hong_Kong）。本文是本地源码检查快照，供本项目后续会话快速接手；接口和部署状态应再次以当前代码与运行环境核对。

用户明确的当前范围：仅处理月下集网站与其 OpenClaw 接口、Skill、下载和归档链路；OpenClaw 独立功能的维护资料不保存在本仓库。

## 1. 项目位置与初始状态

- 外层工作区：`G:\AI\yuexiaji-source-2026-08-21`。
- 实际应用/Git 根目录：`G:\AI\yuexiaji-source-2026-08-21\yuexiaji-source`。
- 检查开始时：分支 `master`，HEAD `fa49930`（2026-09-26，完善 README 功能与部署说明），工作树干净。
- 上一个功能提交：`be95c0d`（同步媒体库、画廊及存储功能更新）。文件夹名称中的 2026-08-21 不代表当前代码版本。
- Git origin：`https://github.com/KONEWS/yuxiaji.git`。这只是本地配置，本次未拉取或核对远端。
- 外层三个 RAR 分卷不参与当前开发；`dist/`、`node_modules/`、`.wrangler/`、`.sites-runtime/` 是已有产物或本地运行目录。
- 用户意图：这个项目继续更新网站；另一个本项目会话处理月下集错误及 OpenClaw 连接错误。本次仅了解代码、记录上下文和运行基础检查，没有修改业务代码或进行线上操作。

## 2. 应用架构

调用链：浏览器组件 → `app/lib/client-api.ts` 同源 `/api` → Worker 路由保护 → App Router API → 业务辅助函数 → D1/R2/外部目录。

OpenClaw 调用链：外部 OpenClaw 主机 → `Authorization: Bearer …` → `/api/agent/*` → Agent 认证/权限 → 幂等审计 → 同一组媒体/设备/图片存储。

- `package.json`：React 19.2.8、Next 16.3.2、Vinext 0.0.50、Vite 8.0.13、Drizzle ORM 0.45.2、Wrangler 4.92.0；这些是当前锁定版本，不代表外部最新版本。
- 实际开发命令是 `vite`，构建是 Vinext，不能只看到 Next 依赖就改为普通 Next 部署方式。
- `vite.config.ts` 将 Vinext 与 Cloudflare Vite plugin 组合，并把开发 Worker 入口指定为 `worker/index.ts`。
- `worker/index.ts` 负责管理员登录保护、写请求 CSRF、临时密码强制修改、图片优化及 favicon 转发。
- `wrangler.jsonc`：Worker 名 `tsuki-anime-rebuild`，入口 `dist/server/index.js`，静态资源 `dist/client`；D1 绑定 `DB`（数据库 `yuexiaji-db`）、R2 绑定 `BUCKET`（桶 `yuexiaji-assets`）、Images 绑定 `IMAGES`。
- `db/index.ts` 直接从 `cloudflare:workers` 取绑定，再创建 Drizzle D1 客户端。依赖 Worker 运行时的模块不能随意放到普通 Node 测试中执行。
- `.openai/hosting.json` 也保留了 Sites 项目关联。配置存在不证明 Sites 或 Cloudflare 线上目前运行的就是本地 HEAD。

## 3. 页面与功能入口

| 功能 | 主要文件 |
| --- | --- |
| 主页面、状态协调、加载缓存、保存队列、搜索与筛选 | `app/page.tsx` |
| 整体外观和主题 | `app/globals.css`、`app/layout.tsx` |
| 媒体网格/列表、统计 | `app/components/tracker/media-library.tsx`、`collection-summary.tsx` |
| 媒体添加、详情、画廊、存储关联、日历 | `app/components/tracker/media-modals.tsx` |
| 设备库/设备编辑/凭证 | `app/components/tracker/device-library.tsx`、`device-modals.tsx` |
| 外观设置、同步、连通性 | `app/components/tracker/integration-modals.tsx` |
| 登录与安全设置 | `app/login/page.tsx`、`app/settings/security/page.tsx`、`app/components/security-panel.tsx` |
| Bangumi 账户设置 | `app/settings/bangumi/page.tsx` |
| 前端类型、枚举和规范化 | `app/lib/tracker-types.ts`、`constants.ts`、`tracker-data.ts` |

媒体类型：`anime`、`movie`、`tv`、`game`、`light_novel`、`manga`、`music`、`visual`、`video`。`book`/`novel` 在部分 API 中归一为 `light_novel`。`Anime` 是历史类型名，实际承载多种媒体。`visual` 表示画廊。

收藏状态：`watching`、`wish`、`finished`、`library`、`dropped`。前六类有收藏进度；音乐、画廊、视频作为独立资产展示。画廊最多 60 张展示图片，媒体最多 12 个存储关联。

主页面先恢复 localStorage 缓存，然后并行加载服务端偏好、媒体和设备；服务端成功响应具有最终优先级。偏好以约 450ms 防抖保存，媒体保存按本地条目排队并映射服务端 ID。排查“保存后回退”“刷新才显示”“Agent 写了但页面没变”时，需要同时检查服务端结果、页面内存及缓存；当前未发现媒体自动轮询或针对 OpenClaw 的实时推送。

## 4. 数据模型

Schema：`db/schema.ts`；SQL 迁移：`drizzle/0000` 至 `0024`。

| 表 | 用途 |
| --- | --- |
| `user_state` | 合集与排序偏好、分类名称、同步字段开关、头像、颜色、字体、背景版本等 |
| `user_subjects` | 媒体主记录、外部来源、进度/评分/标签及 JSON metadata |
| `user_subject_images` | 画廊多图、排序、封面标记、图片 hash；关联媒体表 |
| `media_storage_links` | 媒体的一对多网盘/归档地址，关联媒体表 |
| `user_devices` | 藏品、价格、购买日期、照片/凭证、封面位置与缩放 |
| `agent_operations` | Agent 操作幂等与响应审计 |
| `admin_account`、`admin_sessions`、`admin_auth_logs` | 单管理员账户、会话及认证日志 |
| `bangumi_account` | Bangumi 账号绑定和加密 Access Token |
| `external_service_credentials` | 外部集成加密凭据 |
| `anime_airing_schedule` | 放送计划与自定义计划 |

`user_state.anime_json` 是历史兼容字段，当前 `/api/state` 不从中读写媒体；创建偏好行时仅写 `[]` 以满足 NOT NULL。`user_subjects.thumbnail` 保留兼容画廊主封面，多图以图片表为准。

`media_storage_links` 已增加 `state/operationKey/objectCount/totalBytes/manifestSha256/verifiedAt`（迁移 `0024_salty_nightshade.sql`）；本轮已应用生产 D1 迁移并部署对应 Worker。SQL `0023_classy_jetstream.sql` 包含每条媒体最多 12 个链接的触发器与主存储唯一索引。更改 schema 时不能忽略这些数据库层约束。

`getCurrentUser()` 当前忽略 Request，只返回 Worker 的 `DEFAULT_USER_ID` 或默认 `owner`。浏览器和三个 Agent 都通过此规则使用同一单用户数据域；管理员用户名、Nova/Hikari/Codex 名字和媒体外部 ID 都不是 user key。

## 5. 浏览器 API 与外部来源

- `/api/media`：媒体 GET/POST/DELETE；共享 sanitizer、presenter 位于此路由，也被 Agent 使用。POST 更新会合并已有字段与 metadata。
- `/api/media/storage`：GET/POST/PATCH/DELETE 存储关联，主要实现是 `media-storage-link-store.ts` 与 `media-storage-links.ts`。
- `/api/gallery/images`：画廊图片读取/修改/删除；`gallery-images.ts` 管理多图和无引用 R2 资源清理。
- `/api/devices`、`/api/device-assets`：藏品和图片。
- `/api/state`、`/api/avatar`、`/api/background`：偏好与个人外观资源。
- `/api/search`、`/api/subject`：搜索/详情；来源分派位于 `media-provider.ts`。
- `/api/bangumi/sync`：公开目录刷新/相关导入逻辑；`/api/bangumi/account` 和 `/api/bangumi/account/sync` 是绑定账户与收藏拉取/推送的不同路径。
- `/api/anime/airing`、`/sync`、`/custom`：放送计划；同步支持 SSE 进度。
- `/api/health`：D1 与多个外部来源检查，受管理员保护；它没有验证 OpenClaw Token 或 OpenClaw 主机。

来源：动画/音乐用 Bangumi；游戏用 Bangumi/VNDB；漫画用 Bangumi/AniList/MangaDex；书籍用 Bangumi/AniList/NDL/Google Books/Open Library；电影/电视剧用 TMDB。放送日历有 Bangumi、AniList、AnimeSchedule 和自定义数据，与媒体目录搜索分开。Tokyo 是放送时间计算的主要时区，主界面时钟显示北京时间。

`media-storage-link-batches.ts` 与 `gallery-image-batches.ts` 分批读取，避免 D1 参数上限；当前存储关联批大小是 90，相关回归测试还验证顺序执行和异常传播。

## 6. OpenClaw 契约

### 认证与权限

认证实现：`app/lib/agent-auth.ts`。标准头 `Authorization: Bearer <token>`；当前还兼容 `X-Agent-Token`。Worker 对 `/api/agent` 与 `/api/agent/*` 绕过浏览器 Session 分支，再由各 Agent 路由检查 Token。

Token 变量：`YUEXIAJI_NOVA_TOKEN`、`YUEXIAJI_HIKARI_TOKEN`、`YUEXIAJI_CODEX_TOKEN`，实际读取 Worker 运行时 env。缺少/错误 Token 返回 401；权限不足返回 403。

- Nova：媒体/画廊/视频/存储的读、创建、更新、删除；设备完整权限；标签管理；Bangumi 同步。
- Hikari：媒体/画廊/视频/存储的读、创建、更新；标签只读；Bangumi 同步。没有删除权限、设备权限或标签管理权限。
- Codex：云开发环境专用身份，权限与 Nova 相同，包括删除、设备管理和标签管理；Hikari 权限保持原样。Token 独立配置，必须使用不同于 Nova/Hikari 的值；身份返回 `agent: "codex"`，现有 `source: "openclaw"` 契约保持兼容。线上启用需要部署认证支持并单独配置 Worker Secret，代码修改本身不证明生产 Token 已生效。
- 首先调用 `GET /api/agent`，查看返回的 `agent`、`user`、`permissions`、`endpoints`。该入口只做认证和返回能力，没有数据库写入，也不能证明 D1/R2 完全正常。
- 三个 Token 应使用独立的值；重复值按 Nova、Hikari、Codex 的顺序匹配，身份应由 `/api/agent` 返回值核对。

### 接口与响应

| 接口 | 用途与注意事项 |
| --- | --- |
| `/api/agent/media` | 通用媒体 GET/POST/PATCH/DELETE；单条 GET 用内部 `id`，返回 `subject`/`subjects`；POST 带 `id` 会更新 |
| `/api/agent/gallery` | 强制 `visual` 的画廊接口；返回 `gallery`/`galleries`，按 Pixiv/来源 URL/metadata imageHash 检查重复 |
| `/api/agent/gallery/upload` | POST multipart；字段 `image`、幂等键，可选 `galleryId`/`id`、`sourceUrl`、`isCover` |
| `/api/agent/video` | 强制 `video`；返回 `video`/`videos`，兼容 cover/description/url/subtype 等别名 |
| `/api/agent/devices` | 设备读写，Hikari 无权使用 |
| `/api/agent/tags` | 标签读取和管理；Hikari 只读 |
| `/api/agent/storage` | 按 `mediaId` 读写媒体的存储地址 |
| `/api/agent/sync` | POST Bangumi 同步，包装已有同步路由并加幂等审计 |
| `/api/agent/anime/airing` | Nova/Hikari/Codex 的 `airing:read` 权限；复用网站加密 AnimeSchedule 凭据；只返回日程字段 |

`id`、`mediaId`、`galleryId` 对应月下集数据库内部主键；不能将 Bangumi ID、Pixiv PID、VNDB ID 或上传返回的 `assetId` 当作媒体 ID。`/api/agent/gallery/upload` 的 `assetId` 来自操作记录 ID，已有画廊附图时另有 `galleryImage.id`。

上传检查：输入为有效 JPEG/PNG/WebP，最多 20MB；MIME 和实际内容要一致；通过 Images 按 `width: 1600, fit: scale-down` 转换为 WebP（质量 82），输出最多 5MB，再写 R2。返回 `thumbnailUrl` 是 `/api/media-assets?v=…` 相对 URL，普通图片读取受网站登录保护；OpenClaw 直接无 Cookie 读取此 URL 可能得到 401，应区分上传成功与后续图片预览访问。

存储 POST 需要 `mediaId`、非空 `provider`、`url`/`path` 至少一项；PATCH/DELETE 还要链接 `id`。URL 仅 http/https，不能嵌用户名密码；递归拒绝访问码、密码、Token、Cookie 等凭据字段。provider 不限 MEGA。首个链接自动成为主存储，多个链接仍只允许一个主存储。

### 幂等

`agent-operations.ts` 接受 `Idempotency-Key`、`X-Idempotency-Key` 或 JSON `idempotencyKey`，标准写操作要求非空键，上传也要求键。

- 唯一范围：`userKey + agent + idempotencyKey`，不是每个端点独立。
- 同一业务操作重试使用同一个键；不同端点、条目或修改操作使用不同键。
- 操作占位时 `statusCode=102`；处理中重复调用返回 409；完成后重放此前的状态和 JSON，带 `x-idempotent-replay: true`。
- 当前未校验同键请求体是否一致，也没有 pending 过期恢复逻辑。写入成功而审计失败时可能返回错误或保留 pending；排查要核对媒体实际数据与 `agent_operations`，不能盲目换键重复创建。

## 7. 已确认的实现差异与待核查线索

以下保留最初检查时的线索。第 1、5 项及测试覆盖不足已在本轮修复；当前执行结果以第 10 节和诊断记录为准。

1. **归档扩展字段未落库。** README、SELF_HOSTING 与 `client-api.ts` 类型描述 `state/operationKey/objectCount/totalBytes/manifestSha256/verifiedAt`，但 schema、0023 迁移、sanitizer、store、presenter 都没有这些字段。请求额外传入会被丢弃。`storage.v1` 目前仅见于说明文档，没有实际版本协商。
2. **OpenClaw URL 是遗留字段。** schema 有 `openClawUrl/openClawAgent`，目前 app 中没有消费它们的路径，`/api/state` 也不读写它们。现有网站实现是接受 Agent 调用，并没有调用 OpenClaw Gateway 的流程。`agent-hikari.ts` 的名字容易误导：它实际是网页端 Bangumi 刷新辅助函数。
3. **文档部分旧接口说明落后。** SELF_HOSTING 的稳定接口列表未完整反映 video 与新增外部目录来源；维护或联调时用代码确认。
4. **页面可能需重新加载。** 主页面初始加载和自身操作会更新媒体；未见媒体实时推送/定时同步。Agent 成功写入不代表已打开的页面会立即刷新。
5. **专用资产响应没有存储关联装配。** `agent-media-assets.ts` 调用 `presentSubject(row, images)`，未像通用 `/api/agent/media` 那样读取 storage map，因此画廊/视频专用响应里的 `storageLinks` 默认空数组。实际关联应通过 storage 端点或通用媒体端点核对。
6. **现有测试范围有限。** 存储单元测试验证基本字段和分批查询，Worker 测试只覆盖登录 HTML 与未登录跳转；没有覆盖生产 Token、Agent 写入、归档扩展字段或真实 OpenClaw 主机。

## 8. 后续连接问题的排查顺序

1. 确认实际网站域名、Worker 部署版本、失败操作、HTTP 状态与脱敏响应，并取得 OpenClaw 调用端对应 Skill/配置/日志。当前工作区没有 OpenClaw 主机源码或下载 Skill。
2. 只读 `GET /api/agent`，确认请求确实到了 JSON Agent API、Token 身份、用户归属与权限；不要用浏览器是否已登录判断 Agent 认证。
3. 用 `GET /api/agent/media?id=…` 或 `/api/agent/storage?mediaId=…` 核对内部 ID、归属与数据库可用性。
4. 核对实际目标 D1 是否已应用相应迁移，尤其 `0013` 操作审计、`0020` 多图、`0023` 存储关联。migration 文件存在不等于远端已执行。
5. 对失败写入检查幂等键、请求方法和形状、Hikari 权限、Image/R2 绑定以及审计状态。区分认证 401、权限/CSRF 403、缺记录 404、pending/主存储冲突 409、上传超限 413、图片类型 415 和数据库/绑定 5xx。
6. 对“写入成功但网页不显示”分别检查 GET 返回、响应形状、浏览器刷新/缓存、图片 Session 保护以及本说明第 7 节的字段差异。

## 9. 本地命令与检查基线

所有命令在应用根目录运行。当前本地 Node `v22.22.2`，npm `10.9.7`，已有依赖。

```powershell
npm ci
npm run dev
npx tsc --noEmit
npm run lint
npm run test:storage
npm test
npm run build
```

`npm test` 自带构建，运行 `tests/rendered-html.test.mjs` 和 `tests/media-storage-links.test.ts`。构建脚本支持 Windows，默认超时 180 秒，产物是 `dist/client` 与 `dist/server`。Linux CI 另有 `scripts/install-ci.sh`。

本次已执行：`npx tsc --noEmit` 通过；`npm run lint` 通过；`npm run test:storage` 16/16 通过。本次未运行完整构建/Worker 测试，未启动网页、应用远端迁移、部署或访问生产/OpenClaw 主机。

本地 Worker 配置放在忽略的 `.dev.vars`；本次没有读取其内容。集成变量包括 `TMDB_API_KEY`、可选 `GOOGLE_BOOKS_API_KEY`、两个 Agent Token、凭据加密密钥 `YUEXIAJI_CREDENTIALS_ENCRYPTION_KEY`（兼容 `BANGUMI_TOKEN_ENCRYPTION_KEY`）、可选 `ANIMESCHEDULE_TOKEN` 与 `DEFAULT_USER_ID`。

更新 schema 后使用 `npm run db:generate`，审阅迁移再按目标执行。生产 Wrangler 命令使用根 `wrangler.jsonc`；不要使用构建中间的 `dist/server/wrangler.json` 替代生产配置。迁移不会随部署自动执行。

用户在本轮指定的网站更新顺序（先完成构建/检查）：

```powershell
npx wrangler d1 migrations apply yuexiaji-db --remote --config wrangler.jsonc
npx wrangler d1 execute yuexiaji-db --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;" --config wrangler.jsonc
npx wrangler deploy --config wrangler.jsonc
```

表名检查用于核对数据库对象，涉及 schema 修改时还需核对具体列，并通过生产 Agent API 回读验证。

## 10. 2026-10-02 连接故障排查、修复与上线

详见 [OPENCLAW_DIAGNOSTICS.md](OPENCLAW_DIAGNOSTICS.md)。本节更新第 7 节的初始观察；已完成月下集生产迁移、部署、两份 Skill 更新和历史归档回填。本节只记录月下集相关结果。

- 已通过 Wrangler 只读核对远端 D1，六个归档字段没有对应列；并通过 OpenClaw 主机现有 Token 验证线上 GET 确实缺字段。不是单纯的 presenter 漏返回。
- 本地增加六列、输入校验、保存与回读；旧记录默认 `linked`，未知数量/字节数/校验时间为 null，不推测历史验证状态。
- 画廊/视频专用接口已在本地装配同用户的 storage map，GET 和写响应与通用媒体路径保持一致。
- 生产画廊列表已能返回 115 条，838 单条读取成功；D1 大列表参数上限问题本轮未复现，90 条分批实现已存在，不重复改造。
- OpenClaw 下载器发送带时区 ISO `verifiedAt`，服务端统一回读 Unix 毫秒。服务端接收两种输入；配套 CLI 2.5.1 补丁只对校验时间作等价格式比较，仍严格检查所有其他请求字段。
- 排查开始时 Nova/Hikari 主机 CLI 均为 2.5.0，SHA-256 相同。`Yuexiaji.zip` 的 Skill 副本用于分析和补丁生成；只解压到忽略目录 `work/openclaw-review`，没有覆盖部署副本或读取原图。
- 最新构建通过，32/32 网站测试通过；类型和 lint 通过。新增隔离 Worker/D1 测试覆盖迁移、ISO 时间、POST/GET/PATCH、幂等重放、画廊/视频关联、182 条画廊、用户隔离与权限；另覆盖 AnimeSchedule 代理和编译后 Worker 的 multipart 上传边界。配套 CLI 自测 103/103 通过。
- 已执行用户指定的三条 Wrangler 命令。D1 迁移前备份在忽略目录 `outputs/backups/yuexiaji-db-before-storage-20261002.sql`；迁移 `0024` 成功，表名与六列核对成功。
- 当前 Worker 版本 ID：`fab2a35c-b854-462e-b8d7-b8328a2a4d4b`。两个域名均读取成功，画廊的存储关联与 storage 端点一致，115 条列表正常。
- Nova/Hikari 两份 manager CLI 已更新为 2.5.1，各自 103 项主机离线测试通过。原四个文件分别备份到主机 `~/.openclaw/backups/yuexiaji-manager-2.5.0-before-storage-2.5.1-20261002/`。
- 已补 814、816、822、823、824、825、838、839 的真实归档证据；838 的两条历史链接保留并分别修复。815 根据现存原图的精确 SHA-256 匹配后上传 MEGA、下载回读做完整 SHA-256 校验并关联网站。详情和展示图片的完成情况见诊断表。
- 两个旧 Twitter 故障来源 89/90 的原图已存在、实际文件 hash 匹配下载索引，归档 verified、分享 active；source 90 已匹配已有画廊 825，未重复创建画廊。
- 修复下载器 MEGA stat 成功返回 JSON null 时误判缺失对象的问题；Nova/Hikari 的 adapter 各 14 项测试通过。补丁保存在 `docs/patches/openclaw-storage-null-stat.patch`。
- 新增 Agent AnimeSchedule 日程代理，复用生产网站现存加密凭据，不把 Token 发给 OpenClaw。两个 Agent × 两个域名均 200，上游 119 项；两份 Skill 刷新均成功得到 AnimeSchedule 83 条可用日程。Nova 升级 1.2.1（29 tests）、Hikari 1.3.1（31 tests），保留原有功能差异和生命周期/回执。
- 本轮补展示图片时发现 Vinext 将 multipart API POST 误按默认 1 MiB 先解析。已设置受支持的 21 MiB 框架上限，上传接口仍保留 20 MiB 文件上限；正确序列化的本地 Worker 请求验证 1.2 MB 可进入认证、超过 21 MiB 拒绝。生产有效 Token 的 20 MiB+1 文件返回路由 JSON 413，未创建上传操作。
- 最终历史资产核验：814/815/816/822/823/824/825/838/839 展示图分别为 10/1/3/1/1/2/2/4/1；原封面、排序、thumbnail 和旧图保留。八个真实 downloader source 均 imported、全部文件回执和原/派生 hash 回读，所有存储证据及 gallery/storage 读路径一致。839 有现存 allSent 回执；其他旧来源没有现存投递回执，不能补造或推测 allSent。本轮未重发消息。

## 11. 2026-10-13 GitHub 与 Cloudflare 部署流程

- 用户要求将完整项目推送至 GitHub，方便后续 ChatGPT 修改后直接部署 Cloudflare。沿用现有仓库 `https://github.com/KONEWS/yuxiaji` 与生产分支 `master`，不另建仓库。
- 核对开始时，GitHub 与本地 HEAD 同为 `fa49930`；第 10 节修复、迁移、测试及协作资料尚未提交。本次将这些现有改动连同部署配置一并纳入 Git。
- 已通过 Cloudflare API 只读确认账户 `aefc1cf6e93860c276bae6bbc27888b6` 包含指定 D1 数据库与 `tsuki-anime-rebuild` Worker，线上 D1/R2/Images 绑定与根配置一致。根 `wrangler.jsonc` 固定该账户；GitHub Actions 配置同名账户 Variable。
- 新增 `.github/workflows/cloudflare.yml`：所有推送/PR 执行类型、lint、构建及 32 项测试；`master` 通过后按指定三步部署同次运行已验证的产物。独立部署 Token 存于 GitHub Secret，详情见 [GITHUB_CLOUDFLARE.md](GITHUB_CLOUDFLARE.md)。
- 新增 `npm run check`、远端迁移/表名检查脚本、`deploy:built` 与 `deploy`。后续部署统一使用这些入口，避免遗漏迁移。GitHub 自动部署时不再另外重复本地生产发布。
- `.gitignore` 扩展忽略所有 `.dev.vars*`，仅允许无密钥的 `.dev.vars.example`；编译后 Worker 测试使用独立空环境文件和非持久本地运行时。
- 本地 `npm run check`、`npm test`（32/32）及 Wrangler 部署 dry run 已通过。源码与现有四个历史提交检查未发现实际凭据、私人数据备份或运行产物；生产数据库、R2 图片与密钥继续留在 Cloudflare。
- GitHub 的 Linux 检查也已通过。已按用户确认创建 `yuexiaji-github-actions` 专用 Token 并保存为 Actions Secret；编辑权限限 `tsuki-anime-rebuild`，D1 Write 与 Workers Content Read-Only 限本账户，无到期日。账户级只读权限用于 Wrangler `4.92.0` 在上传后读取 Workers 子域名；仅指定 Worker Editor 的首次发布已更新网站，但收尾查询因权限不足而失败。后续以对应 GitHub Actions 的最终结果和实际线上响应为准。
