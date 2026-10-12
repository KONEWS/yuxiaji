# GitHub 与 Cloudflare 部署

GitHub 仓库：<https://github.com/KONEWS/yuxiaji>。应用根目录就是仓库根目录，生产分支为 `master`。

生产目标由根目录 `wrangler.jsonc` 决定：Worker `tsuki-anime-rebuild`、D1 `yuexiaji-db`、R2 `yuexiaji-assets`，以及现有 Images 绑定。后续修改先读取 `AGENTS.md` 与 `docs/PROJECT_CONTEXT.md`，再检查当前代码和 Git 状态。

## 一次性配置

GitHub Actions 需要独立的 Cloudflare 部署 Token 和 Account ID；本地 Wrangler 的登录状态不会传到 GitHub。

1. 在 Cloudflare 创建 API Token，限制到本项目所在账户。授予现有 Worker 的部署权限（Workers Editor；旧界面对应 Workers Scripts Edit），以及 D1 Edit，供迁移和表结构查询使用。仅绑定现有 R2 桶不需要额外的 R2 写权限；如以后需要修改域名或路由，再按实际需要增加对应 Zone 权限。参考 [Cloudflare GitHub Actions 说明](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)、[Workers 权限](https://developers.cloudflare.com/workers/authorization/workers/) 与 [Token 权限](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)。
2. 打开 GitHub 仓库的 **Settings → Secrets and variables → Actions**。新增 Secret `CLOUDFLARE_API_TOKEN`；新增 Variable `CLOUDFLARE_ACCOUNT_ID`，填写 `aefc1cf6e93860c276bae6bbc27888b6`（已核对包含现有 D1 和 Worker 的账户，与根配置相同）。工作流也接受同名 Account ID Secret。
3. 工作流使用 GitHub Environment `production`。可将上述配置放在该 Environment，或沿用仓库级配置。若设置 Environment 保护规则，将允许部署的分支设为 `master`；要求人工审核时，GitHub 会在每次生产部署前等待审核。
4. 在 **Actions → Check and deploy Cloudflare → Run workflow** 中选择 `master`，执行首次验证和部署。检查全部步骤的实际结果；密钥缺失会明确失败，方便识别未完成的配置。

已有管理员账户、Agent Token、外部 API key 与凭据加密密钥继续保存在 Cloudflare/D1。这个工作流只使用部署 Token，不上传或重写应用密钥。不要把 `.dev.vars`、`.env`、Wrangler OAuth 登录文件、数据库备份或网盘凭据提交到 GitHub，也不要把本地 OAuth Token 当作长期 CI 密钥。

## 日常修改与自动部署

建议在功能分支修改，通过 Pull Request 审阅后合并到 `master`。在具备仓库写入权限的 ChatGPT/Codex 环境中，后续 Agent 可按照同样的流程提交修改。

- 每次分支推送、Pull Request 和手动运行都会执行 `npm ci`、`npm run check`、`npm test`。`npm test` 已包含构建和全部回归测试，采用 Node.js `22.22.2` 与锁文件。
- `master` 推送（包括合并 Pull Request）通过检查后自动部署生产。其他分支的手动运行只执行检查；生产手动运行必须选择 `master`。
- 部署 job 下载同一次运行已测试的 `dist/client` 与 `dist/server`，包含构建所需隐藏文件，随后调用 `npm run deploy:built`。Cloudflare 凭据仅提供给凭据检查与部署步骤；Pull Request 检查不接收部署 Token。
- 正在执行的生产流程不会被后续推送取消。GitHub 保留最新的待运行流程；开始部署前会再核对 `master`，旧提交的重跑会停止，避免覆盖更新版本。
- 如果仓库配置了 Cloudflare Workers Builds 或其他部署服务，请只启用一个生产自动部署入口，避免同一个提交重复部署或漏掉数据库迁移。

GitHub 工作流位于 [`.github/workflows/cloudflare.yml`](../.github/workflows/cloudflare.yml)。Actions 的生产 job 记录迁移、表名查询和 Worker 版本；完成后仍需核对真实网站与本次修改涉及的 API。

## 部署顺序与数据库

`npm run deploy:built` 使用已验证产物，严格按照项目指定顺序运行：

```bash
npx wrangler d1 migrations apply yuexiaji-db --remote --config wrangler.jsonc
npx wrangler d1 execute yuexiaji-db --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;" --config wrangler.jsonc
npx wrangler deploy --config wrangler.jsonc
```

GitHub CI 无交互运行迁移，Wrangler 会跳过确认并捕获备份；失败的迁移会回滚，此前成功的迁移保持已应用状态。参考 [D1 迁移命令](https://developers.cloudflare.com/d1/wrangler-commands/#d1-migrations-apply)。任何一步失败都会停止后续部署。

Schema 变更必须提交经过审阅的 `drizzle/*.sql` 和对应元数据。尽量采用与当前线上版本兼容的迁移；迁移已成功而 Worker 部署失败时，数据库仍保留新 Schema。涉及删表、删列或改变已有数据含义的迁移，先按项目要求安排备份与验证，再合并生产分支。表名查询用于核对数据库对象，新增/更改列还需要检查实际字段与生产 API 回读。

GitHub 保存源码、迁移、测试和配置。生产 D1 数据、R2 图片、管理员信息与密钥保存在原有 Cloudflare 资源中；更换账户或新建环境时，需要另行迁移数据并配置资源绑定和密钥。

## 后续 Agent 操作清单

1. 读取项目协作说明并核对 `git status`，保留其他会话尚未提交的工作。
2. 基于最新 `master` 修改源码；有 Schema 修改时生成、审阅并提交迁移。
3. 执行 `npm run check` 和 `npm test`，修复失败后再提交。
4. 推送功能分支并创建 Pull Request；在获得合并授权后合并到 `master`，或按用户已授权的方式直接推送 `master`。
5. 等待对应 Actions 检查和生产部署完成，记录实际 Worker 版本，并检查本次修改的线上行为。工作流失败时读取具体失败步骤，不把源码推送成功视为部署完成。
