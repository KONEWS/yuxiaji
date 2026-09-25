# 月下集：自有云迁移约定

前端只通过同源 `/api` 访问数据，不直接依赖数据库、对象存储或部署平台。当前实现使用 D1 与 R2；以后迁移到自己的云服务器时，页面和交互层无需重写，只替换三组服务端接口即可。

## 原图网盘归档

网站不会直接登录 MEGA，也不会保存 rclone remote、网盘账号、密码或 token。OpenClaw 在自己的
主机上通过 rclone 完成不可覆盖上传和完整校验，然后只把 provider、分享 URL、远端归档路径、
校验状态和摘要写入 `/api/agent/storage`。浏览器使用 `/api/media/storage` 管理同一组私有链接。

上线顺序：先应用 `drizzle/0023_classy_jetstream.sql` 与后续迁移，再部署 Worker；随后在 OpenClaw
主机交互式配置 rclone/MEGA，并用独立的 Agent token 回填链接。不要把 rclone 配置或 MEGA
凭据放进 Wrangler vars/secrets、D1、源代码或 API 请求。

## 稳定接口

- `GET /api/state`：读取界面设置与用户偏好。
- `POST /api/state`：保存界面设置与用户偏好；不读写媒体记录。
- `GET /api/media`：读取当前用户的动画、电影、电视剧、游戏、书籍、漫画、音乐与画廊记录，可按个人标签筛选。
- `POST /api/media`：新增或更新一条媒体记录。
- `DELETE /api/media?id=`：删除当前用户的媒体记录。
- `GET /api/devices`：读取装备库与在役/投入统计。
- `POST /api/devices`：新增或更新设备。
- `DELETE /api/devices?id=`：删除设备。
- `GET /api/search?q=&type=`：按媒体类型搜索；动画、游戏、书籍、漫画和音乐使用 Bangumi，电影与电视剧使用 TMDB。
- `GET /api/subject?id=&type=`：读取 Bangumi 或 TMDB 媒体详情。
- `GET /api/bangumi/sync`：返回 Bangumi 同步能力与认证模式。
- `POST /api/bangumi/sync`：按媒体类型刷新当前用户已绑定的 Bangumi 条目；默认使用公开 API，可通过 `x-bangumi-user-token` 或请求体中的 `userToken` 预留 user token。
- `GET /api/background`：读取当前用户背景。
- `POST /api/background`：上传当前用户背景。
- `GET /api/media/storage?mediaId=`：读取媒体的全部存储位置。
- `POST/PATCH/DELETE /api/media/storage`：管理媒体存储位置；可保存多个 provider、分享 URL、路径、验证状态和清单摘要。

浏览器端的调用集中在 `app/lib/client-api.ts`。迁移时应保持这些接口的输入输出不变。

Bangumi Access Token 由管理员绑定接口接收，并使用 Worker 加密密钥加密后保存在 D1；明文不会返回浏览器或写入日志。

存储关联是 provider-neutral 的 `storage.v1` 交接边界。网站端不接受访问码、密码、token、Cookie 或 rclone 配置字段，也不直接上传/读取 MEGA 原图。OpenClaw 下载 Skill 在完成 rclone + MEGA 上传和完整校验后，通过 `/api/agent/storage` 写回 `provider`、`url`、`path`、`state`、`operationKey`、对象数量/字节数和 manifest SHA-256。未填写存储地址时，详情页将该区域保持折叠。

影视元数据通过 Cloudflare Worker 环境变量 `TMDB_API_KEY` 读取。生产环境可使用 `npx wrangler secret put TMDB_API_KEY --config wrangler.jsonc` 写入；本地 Wrangler 使用项目根目录的 `.dev.vars` 提供同名变量。密钥不会写入数据库或返回给浏览器。

## 推荐的自有云结构

1. 保持单管理员密码、TOTP 和 HttpOnly Session Cookie 认证；Agent API 继续使用隔离的 Bearer Token。
2. 将 `user_state`、`user_subjects`、`user_devices` 和管理员相关表迁移到 PostgreSQL 或 SQLite；`user_state` 只保留界面偏好。
3. 将背景文件迁移到 S3 兼容存储或服务器数据目录，数据库只保存版本与归属信息。
4. 服务端继续代理 Bangumi 搜索，避免在浏览器中暴露额外配置并统一处理限流。
5. 应用容器保持无状态，持久数据放在数据库和对象存储中，方便滚动升级与备份。

## 迁移边界

平台存储与认证实现主要位于：

- `db/index.ts`
- `db/schema.ts`
- `app/api/state/route.ts`
- `app/api/media/route.ts`
- `app/api/devices/route.ts`
- `app/api/background/route.ts`
- `app/lib/admin-auth.ts`
- `app/lib/agent-auth.ts`
- `worker/index.ts`

更换这些实现并保留接口契约后，`app/page.tsx`、响应式样式和用户数据结构可以继续使用。
