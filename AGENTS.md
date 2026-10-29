# 月下集项目协作说明

## 开始工作

- 本目录是应用和 Git 仓库根目录。用户指定后续网站更新在这里进行。
- 本项目只处理月下集网站及其 OpenClaw 接口、Skill、下载和归档链路。OpenClaw 的独立运行环境、记忆、语音和模型计费问题不属于本项目范围。
- 先读 `docs/PROJECT_CONTEXT.md`、`README.md`；涉及 OpenClaw、网盘归档或迁移时再读 `SELF_HOSTING.md` 和相关代码。
- `docs/PROJECT_CONTEXT.md` 已记录代码地图、Agent 接口契约、已发现的文档与实现差异及检查基线。以当前源代码为准，修复后更新相关说明。
- GitHub 仓库为 `KONEWS/yuxiaji`，生产分支为 `master`；部署和后续更新读取 `docs/GITHUB_CLOUDFLARE.md`。GitHub Actions 会验证所有推送/PR，并在 `master` 检查通过后自动部署；提交前核对本次是否已获生产更新授权。
- 用户会在同一项目开另一个会话修复网站和 OpenClaw 连接问题。编辑前核对 `git status`/差异，保留其他会话和用户的改动；遇到同一文件的并发修改先协调，不覆盖、不重置。

## 实现边界

- 当前使用 Vinext + Vite + React 的 App Router，运行在 Cloudflare Workers，数据存储是 D1 + Drizzle，展示图片在 R2，Agent 图片转换依赖 Images。
- 网站是单管理员应用。浏览器 Session/CSRF 与 Agent Token 认证分离；保留 `worker/index.ts` 对 Agent 路径的隔离。
- Agent 为 Nova/Hikari/Codex，权限见 `app/lib/agent-auth.ts`。Codex 使用独立 `YUEXIAJI_CODEX_TOKEN`，权限与 Nova 相同，包括删除、设备管理和标签管理，不替换现有 Token；Hikari 保留原有受限权限。写操作的幂等与审计见 `app/lib/agent-operations.ts`。
- 普通 ChatGPT 的内容连接走 `/mcp` 和独立 OAuth；内部 `chatgpt` 身份只由授权后的服务端 Request 对象创建，没有公开 Agent Token 或 Header 入口。它默认只能读取、新增、编辑内容；单独授予 `content:delete` 后才可通过白名单工具删除单条媒体、藏品或存储关联。删除必须校验精确 ID、预期标题/名称及确认参数，保留操作审计。仍禁用批量同步、源码、部署与账户工具。保留 `mcp-content-tools.ts` 的字段白名单，不能开放媒体类型转换或 `images` 全量替换。
- 当前用户数据归属由 `DEFAULT_USER_ID` 决定，缺省 `owner`；不是请求参数或 Agent 名称。涉及归属问题先核对这一实现。
- `/api/state` 保存偏好；媒体主数据在 `user_subjects`，不要重新从 `anime_json` 或浏览器缓存覆盖媒体表。
- 网盘原图归档由外部 OpenClaw 完成；网站存展示图与存储关联。不要将网盘凭据、rclone 配置、Agent Token 或 `.dev.vars` 内容写入代码、文档或日志。
- `.openai/hosting.json` 是已有 Sites 项目关联，`wrangler.jsonc` 是 Cloudflare 根部署配置。实际部署前核对本次请求的目标和相关部署说明，不根据旧 `dist/` 推断线上版本。

## 验证

- 使用现有 npm 锁文件和脚本。Node 要求 `>=22.13.0`。
- GitHub Actions 使用 Node `22.22.2`，运行 `npm ci`、`npm run check`、`npm test`；`npm test` 包含构建，不必重复构建。部署使用同次运行已测试的产物。
- 常规检查：`npx tsc --noEmit`、`npm run lint`。
- 存储关联/画廊分批查询检查：`npm run test:storage`。
- Agent 番剧排期代理检查：`node --test tests/airing-api.test.mjs`。
- `npm test` 会先构建，再运行全部 14 个测试文件（含本地 Worker 登录页、存储、MCP/OAuth、保存冲突等）；`npm run build` 使用 `scripts/build-verified.mjs`。
- Vinext 会先按 progressive-action 上限解析 multipart API POST。`next.config.ts` 的 21 MiB 上限为画廊 20 MiB 文件加表单开销留空间；不能直接删除此配置，否则大图会在进入上传路由前返回 413。编译后 Worker 测试覆盖此边界。
- Schema 变化需生成并审阅新迁移。部署不会自动应用 D1 迁移；远端迁移、生产部署和 OpenClaw 主机操作按当前用户请求执行，不能把本地检查当作线上验证。
- 用户指定的网站更新命令顺序：`npx wrangler d1 migrations apply yuexiaji-db --remote --config wrangler.jsonc`；`npx wrangler d1 execute yuexiaji-db --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;" --config wrangler.jsonc`；`npx wrangler deploy --config wrangler.jsonc`。部署前完成对应构建与检查，按 schema 变化核对具体列；列出表名不能代替字段与 API 回读验证。
- `npm run deploy:built` 封装上述三步，并在发布后只读验证 MCP OAuth 表字段和线上协议边界；`npm run deploy` 先检查、构建和测试再执行。该线上验证不创建授权、不读写收藏。本地生产部署与 GitHub Actions 部署只选择一个入口，避免重复发布；已推送 `master` 时优先等待对应 Actions 结果。
