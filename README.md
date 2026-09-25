# 月下集

月下集是部署在 Cloudflare Workers 上的私人媒体收藏与藏品管理应用。前端使用 Vinext/React，D1 保存条目、放送计划、账户及设置，R2 保存上传的展示图片。网站是单管理员应用，不是公开的多人目录或原图网盘。

## 主要功能

### 媒体收藏

- 管理动画、电影、电视剧、游戏、书籍（含轻小说）、漫画、音乐、画廊和视频九类条目。动画、电影、电视剧、游戏、书籍和漫画可以记录收藏状态与进度；音乐、画廊和视频作为独立媒体资产展示，不强制套用追番进度状态。
- 可手动添加未收录于外部目录的作品；来源 ID 是可选关联，不要求手动条目硬匹配。添加时也可以搜索外部目录，或直接输入 Bangumi ID / VNDB ID 获取详情。
- 支持个人评分、标签、合集、搜索、排序、评分筛选、网格/列表布局及批量选择删除。媒体类型与收藏状态可组合筛选，标签支持复选；标签管理可搜索、置顶、隐藏、重命名和合并。
- 作品详情可维护封面、简介、备注及来源 ID。支持关联多个外部来源 ID 和 ISBN；上传封面可调整水平/垂直焦点与缩放比例，而不改动原始图片。

外部目录搜索与详情按媒体类型选择来源，某一来源不可用时仍可使用其他可用来源：

| 媒体类型 | 外部来源 |
| --- | --- |
| 动画、音乐 | Bangumi |
| 游戏（含视觉小说） | Bangumi、VNDB |
| 漫画 | Bangumi、AniList、MangaDex |
| 书籍、轻小说 | Bangumi、AniList、NDL、Google Books、Open Library |
| 电影、电视剧 | TMDB（需要 `TMDB_API_KEY`） |

动画放送日历另外使用 Bangumi、AniList、AnimeSchedule 和自定义放送数据，不等同于上述媒体目录搜索。Bangumi 账号可按所选媒体类型导入收藏，或将来源为 Bangumi 的收藏状态、评分与进度等写回；公开目录资料刷新与账号同步是独立操作。Bangumi、VNDB 的封面、标题、简介、评分有独立的字段同步开关，避免资料刷新覆盖不希望被替换的手工内容。

### 画廊与视频

- 一条画廊最多保存 60 张图片，可以追加、排序、选择封面或删除单张图片；旧的单封面条目仍可读取。支持插画、壁纸、游戏 CG、截图等子类；视频也有独立子类。
- 上传图片保存到 R2，用于网页展示。画廊的多图、原图的远端归档和媒体封面是不同的数据：网站的图片展示不代表它保存了网盘原图。
- 透明 PNG 在展示层使用统一背景；图片文件本身不会因展示背景而被改写。

### 藏品库与外观

- 藏品库管理音频、游戏穿戴、电脑硬件、移动配件等设备及自定义分类/子类；可记录在役/备用/退役、价格、购入日期、评分、标签、备注、照片和购买凭证，并查看数量与投入汇总。
- 媒体与藏品库都有网格/列表布局。外观可设置头像、主辅色、字体与背景图片淡化程度；上传的媒体和设备封面支持显示位置与缩放调整。

### 网盘关联与 OpenClaw

- 所有媒体类型都可关联多个网盘或归档位置（每条最多 12 个）。详情页未填写时将该区域保持折叠。链接可以保存 provider、分享 URL、远端路径和备注；OpenClaw 回填的归档记录还可带验证状态与清单摘要。
- 网页通过 `/api/media/storage` 管理链接，OpenClaw 通过独立 Bearer Token 的 `/api/agent/storage` 管理。`/api/agent` 提供媒体、画廊、图片上传、视频、藏品、标签和 Bangumi 同步等接口，并按 Agent 身份检查权限。
- 网站不登录 MEGA，也不保存网盘密码、访问码、rclone 配置或原图。下载、原图归档、完整性校验与分享由外部 OpenClaw 下载 Skill 负责；月下集只接收经过权限校验的条目和归档关联元数据。相关自有云迁移边界见 [SELF_HOSTING.md](SELF_HOSTING.md)。

### 账户与安全

- 首次初始化单一管理员后，使用密码登录；可启用 TOTP 双因素认证并使用恢复码。管理员可管理会话、设备、密码及登录安全设置。
- 网页使用 HttpOnly Session Cookie，写操作检查 CSRF；`/api/agent/*` 只接受 Nova/Hikari Bearer Token，不会借用网页会话。Bangumi Access Token 在 Worker 内加密后存入 D1，不向浏览器返回明文。
- `/api/health` 检测数据库和外部数据源连通性。所有媒体与存储链接查询均按当前用户隔离；大列表的画廊图片及存储链接按批读取，避免 D1 单条查询的参数上限。

## 运行环境

- Node.js `>=22.13.0`
- Cloudflare Workers、D1、R2 和 Images
- Linux CI 安装脚本额外需要 `flock`、`curl` 和 GNU `timeout`

## 本地开发

```bash
npm ci
npm run dev
```

本地 Worker 密钥放在忽略提交的 `.dev.vars` 中。按实际使用的集成配置环境变量：

- `TMDB_API_KEY`：电影、电视剧目录搜索与详情
- `GOOGLE_BOOKS_API_KEY`：Google Books 可选 API key
- `YUEXIAJI_NOVA_TOKEN`、`YUEXIAJI_HIKARI_TOKEN`：对应 Agent 的 Bearer Token
- `YUEXIAJI_CREDENTIALS_ENCRYPTION_KEY`：集成凭据加密密钥；兼容旧名称 `BANGUMI_TOKEN_ENCRYPTION_KEY`
- `ANIMESCHEDULE_TOKEN`：AnimeSchedule 可选令牌；也可在账户集成设置中绑定
- `DEFAULT_USER_ID`：单用户数据归属标识

首次安装需先应用 D1 迁移并完成管理员初始化。不要把 `.dev.vars`、网盘凭据或 Token 提交到 Git。缺少外部服务的可选密钥时，对应来源可能不可用，但不应把它当作媒体数据丢失。

## 数据与认证边界

- `user_subjects` 是媒体主数据，`user_subject_images` 保存画廊的多张展示图片，`user_devices` 保存藏品；`/api/state` 保存界面偏好，不覆盖媒体记录。
- `media_storage_links` 为所有媒体类型提供一对多的网盘/归档关联；只存储地址和元数据，不存原图或网盘登录凭据。
- 浏览器通过同源 `/api` 调用服务；管理端点受管理员会话保护，Agent 端点按 Bearer Token 身份和权限隔离。

## 数据库迁移

迁移文件位于 `drizzle/`。新环境或包含新迁移的版本，在部署前按目标环境执行；备份生产数据并确认目标数据库后再运行：

```bash
npx wrangler d1 migrations apply yuexiaji-db --remote --config wrangler.jsonc
```

修改 `db/schema.ts` 后，可用以下命令生成新迁移：

```bash
npm run db:generate
```

迁移不会随 `wrangler deploy` 自动执行。本 README 更新本身不需要迁移。

## 检查与部署

```bash
npx tsc --noEmit
npm run lint
npm test
npm run build
npx wrangler deploy --config wrangler.jsonc
```

`npm test` 会先构建，再运行存储链接/画廊分批查询测试与本地 Cloudflare Worker 登录页测试。生产密钥使用 `wrangler secret put` 配置，不要写入 `wrangler.jsonc`；`dist/server/wrangler.json` 是构建中间产物，生产命令使用根配置。

## 主要目录

- `app/`：页面、组件、API 路由及业务逻辑
- `db/`：Drizzle schema 与 D1 访问入口
- `drizzle/`：数据库迁移
- `worker/`：认证路由保护与 Worker 入口
- `public/`：静态资源
- `tests/`：回归与 Worker 运行时测试
- `scripts/`：CI 安装及跨平台构建辅助
