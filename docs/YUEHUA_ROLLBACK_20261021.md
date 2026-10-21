# 月华上线与回滚记录（2026-10-21）

本次用户已明确授权直接上线，并要求先备份以便回滚。

## 上线前恢复点

- 完整源码提交：`8447efe0b07ff4234dfd0f081ecdc90d03236cbf`。
- 已创建持久备份分支：[`backup/pre-yuehua-20261021-8447efe`](https://github.com/KONEWS/yuxiaji/tree/backup/pre-yuehua-20261021-8447efe)。
- 上线前 Cloudflare Worker：`tsuki-anime-rebuild`。
- 通过 Cloudflare API 只读核对，100% 流量版本：`adcb4d41-ed53-44f7-b930-9fb51c47d910`。
- 对应 Deployment：`ea517f06-b32a-4b19-902b-9dfe1eaeeec3`，创建于 2026-10-20T04:46:49.239907Z。
- 上一轮成功生产流水线：https://github.com/KONEWS/yuxiaji/actions/runs/39371246828 。

源码备份分支保存整个仓库的受版本管理文件，不包含生产数据库、图片或密钥。本次不新增数据库迁移，不更改 D1/R2/Secrets；不得把源码备份称为数据备份。

## 发布内容与验证

- 外观功能提交：`08dc69435486177ddae0a6f592d2f21bc891d200`，PR #2。
- 类型、lint、构建和 66 项测试通过：https://github.com/KONEWS/yuxiaji/actions/runs/39560456983 。
- 使用 master 的现有 Actions 发布，不另行从本地部署。
- 保留经典外观。首页右下角「月华」按钮开启，`/?theme=yuehua` 临时预览，`/?theme=classic` 临时使用经典。
- 登录保护仍生效；没有管理员会话时只能检查登录页、公开静态资产与协议边界，不能声称完成登录后业务和视觉验收。

## 回滚方式

1. 只需恢复经典视觉时，点击「月华 · 已开启」关闭；本次只改变当前浏览器的外观偏好。
2. 需要完整撤回此次发布时，在最新 master 上 revert 本次 PR 的合并提交（`git revert -m 1 <merge-sha>`），按项目规范检查、推送 master，并等待新的 Actions 验证和生产发布完成。核对合并提交第一父节点及之后的并发提交，不强推、不重置 master。
3. 如需紧急恢复 Worker，可由具备部署权限的管理员使用 Cloudflare 的版本回滚，目标为上述旧版本；回滚前确认没有更新的部署/迁移或绑定变化影响兼容性。本次没有数据结构变化。当前用量连接保持只读，不能通过它执行回滚写操作。
4. 回滚后复查部署版本、登录响应、公开协议与静态资源。不要重跑旧 master 的部署流水线：工作流会拒绝非最新 master，应该建立新的回滚提交。
