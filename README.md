# 月下集

月下集是运行在 Cloudflare Workers 上的私人全媒体收藏系统。应用使用 Vinext/React，D1 保存媒体、设备、放送计划和管理员数据，R2 保存用户上传的图片。

## 运行环境

- Node.js `>=22.13.0`
- Cloudflare Workers、D1、R2 和 Images
- Linux CI 安装脚本额外需要 `flock`、`curl` 和 GNU `timeout`

## 本地开发

```bash
npm ci
npm run dev
```

本地 Worker 密钥放在忽略提交的 `.dev.vars` 中。项目使用以下可选变量：

- `TMDB_API_KEY`
- `YUEXIAJI_NOVA_TOKEN`
- `YUEXIAJI_HIKARI_TOKEN`
- `YUEXIAJI_CREDENTIALS_ENCRYPTION_KEY`（兼容旧名称 `BANGUMI_TOKEN_ENCRYPTION_KEY`）
- `ANIMESCHEDULE_TOKEN`
- `DEFAULT_USER_ID`

## 数据与认证边界

- 网页只允许一个管理员账号，使用密码、TOTP 和 HttpOnly Session Cookie。
- `/api/agent/*` 只接受 Nova/Hikari Bearer Token，不接受网页 Session。
- `user_subjects` 是媒体主数据；`/api/state` 只保存界面偏好，不保存或覆盖媒体。
- 放送计划可由 Bangumi、AniList、AnimeSchedule 和用户自定义来源提供。

## 数据库迁移

迁移文件位于 `drizzle/`。部署前按环境执行：

```bash
npx wrangler d1 migrations apply yuexiaji-db --remote --config wrangler.jsonc
```

修改 `db/schema.ts` 后，可用以下命令生成新迁移：

```bash
npm run db:generate
```

## 检查命令

```bash
npx tsc --noEmit
npm run lint
npm test
npm run build
```

`npm test` 会先构建，再通过本地 Cloudflare Worker 运行时验证登录页渲染和未登录首页保护。

## 部署

先构建，再使用根目录的 `wrangler.jsonc` 部署：

```bash
npm run build
npx wrangler deploy --config wrangler.jsonc
```

生产密钥使用 `wrangler secret put` 配置，不要写入 `wrangler.jsonc` 或提交到仓库。`dist/server/wrangler.json` 是构建中间产物，生产命令始终使用根配置。

## 主要目录

- `app/`：页面、组件、API 路由和业务逻辑
- `db/`：Drizzle schema 与 D1 访问入口
- `drizzle/`：数据库迁移
- `worker/`：认证路由保护和 Worker 入口
- `public/`：运行时静态资源
- `tests/`：Worker 运行时测试
- `scripts/`：CI 安装和跨平台构建辅助
