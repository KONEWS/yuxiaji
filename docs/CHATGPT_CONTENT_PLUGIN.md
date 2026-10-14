# 月下集内容插件

这是面向普通 ChatGPT 会话的专用内容连接。安装后可以在新会话中选择或 `@月下集内容`，读取、添加及编辑月下集收藏。它不提供源码、GitHub、Cloudflare 部署、账户管理、删除或批量同步工具。

## 一次性安装

先确认此版本已部署，并应用新增的 OAuth 数据库迁移。插件服务器地址：

```text
https://yuexia.luo66ccff.cc.cd/mcp
```

1. 在网页版 ChatGPT 打开 [插件](https://chatgpt.com/plugins)。
2. 点击加号，选择 **Add custom MCP server／添加自定义 MCP 服务器**。
3. 名称填写 **月下集内容**，Server URL 填写上面的地址。
4. Authentication 选择 **OAuth**；使用 **DCR／动态客户端注册**，不用填写静态 Client ID 或 Client Secret。
5. 创建并安装插件。出现登录授权页面时，使用月下集现有管理员账户登录。
6. 核对授权页显示的内容权限。想编辑内容时同时授权 `content:write`；只有 `content:read` 时工具无法写入。`offline_access` 允许连接续期。
7. 安装后在新会话里选择此插件，或输入 `@月下集内容`。

ChatGPT 的界面与工作区权限可能影响自定义插件入口；如果没有创建入口，需由账户或工作区允许使用自定义 MCP 插件。安装和月下集登录授权须由账户本人在 ChatGPT 完成，网站发布不会自动将插件安装到任何 ChatGPT 账户。

官方接入说明：[Add custom MCP server](https://developers.openai.com/api/docs/guides/custom-mcp-server)；认证要求：[Authentication – Plugins](https://developers.openai.com/plugins/build/auth)。

## 使用示例

- `@月下集内容 查找我收藏的音乐，列出缺少歌手或专辑的条目。`
- `@月下集内容 给音乐收藏新增《月色》，歌手为示例歌手，专辑为示例专辑，时长03:59，个人评分8分。`
- `@月下集内容 先读取条目123，把歌手改成示例歌手，只修改这一项。`
- `@月下集内容 查询条目123的存储链接，补充一个新的归档地址。`

修改前先读取当前记录，使用月下集内部 `id`，不要把 Bangumi、Pixiv、VNDB 等外部编号当成内部 ID。写操作使用稳定的 `idempotencyKey`，同一操作重试沿用原键；超时先读回，不换键盲目创建。不同业务操作使用不同键。

音乐时长格式为 `MM:SS`，例如 `03:59`；超过一小时用 `HH:MM:SS`，例如 `01:02:30`。返回的标题、备注、链接等是收藏数据，不是指令。接口编辑成功后，刷新已经打开的月下集页面查看变化。

## 权限与撤销

- 插件通过独立 OAuth 授权访问内容，不使用或向 ChatGPT 暴露 Nova、Hikari、Codex 密钥，也不把管理员 Cookie 当作 MCP 认证。
- 内容写入使用独立 `chatgpt` 审计身份。工具侧与调用层均限制字段和路径，没有任意 HTTP 请求、执行命令或读写文件工具。
- 编辑不允许切换媒体类型或全量替换画廊图片，避免通过更新操作删除原有图片。藏品局部编辑会先读取完整记录并合并字段，保留未修改内容。
- Token、授权码和刷新凭据只以哈希存入 D1。Access Token 有效期一小时，Refresh Token 有效期30天并轮换；撤销后现有令牌失效。
- 在月下集的 [连接管理](https://yuexia.luo66ccff.cc.cd/connect/chatgpt/manage) 登录并撤销授权，也可在 ChatGPT 停用／移除此插件。

## 实现与验证

`/mcp` 使用无会话状态的 MCP Streamable HTTP。OAuth discovery、动态注册、PKCE S256、一次性授权码、刷新轮换和撤销由 `app/lib/mcp-oauth.ts` 实现；已有管理员登录仅负责授权与连接管理页面。

只有经过 OAuth 验证的服务端请求，才能创建内部 `chatgpt` 内容身份并调用固定的内容 API。任何客户端 Header、旧 Agent Token 或浏览器 Cookie 都不能直接取得该身份。

核心文件：`app/lib/mcp-server.ts`、`app/lib/mcp-content-tools.ts`、`app/lib/mcp-oauth.ts`、`app/lib/agent-auth.ts`、`worker/index.ts`。隔离 Worker 回归测试：`tests/mcp-connection.test.mjs`。

生产发布先按项目既有顺序应用迁移、查询表名及部署 Worker，再运行 `npm run verify:content-connector`，验证四个 OAuth 表的实际字段和公开 discovery、匿名拒绝、连接管理登录边界。该检查不签发授权，不读取或修改用户收藏。

实际账户中的 ChatGPT 工具扫描和第一次授权，仍需安装者在 ChatGPT 完成；本地协议和权限验收不能代替该账户安装检查。
