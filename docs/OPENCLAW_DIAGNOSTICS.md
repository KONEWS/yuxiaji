# 月下集与 OpenClaw 接入诊断记录

检查日期：2026-10-02（Asia/Hong_Kong）。本记录仅涵盖月下集网站与其 OpenClaw 接口、Skill、下载和归档链路。本轮完成网站生产迁移和部署、Nova/Hikari 月下集 Skill 更新及历史归档修复。OpenClaw 独立功能的维护资料已移出仓库。

当前 Worker：`fab2a35c-b854-462e-b8d7-b8328a2a4d4b`。生产入口为用户域名 `yuexia.luo66ccff.cc.cd` 和 `tsuki-anime-rebuild.jlkonehws.workers.dev`；二者使用同一数据域 owner。现有 Token 分别验证为 Nova/Hikari，未更换凭据、未发送消息。

## 网站与 CLI 契约

1. **生命周期字段确实被丢弃。** 生产 D1 原先没有六列，旧 sanitizer/store 也没有保存字段。POST 成功不能证明归档证据保存。采用服务端完整修复，添加 `state/operationKey/objectCount/totalBytes/manifestSha256/verifiedAt`，应用迁移 `0024_salty_nightshade.sql`，保存并回读所有字段。
2. **专用画廊/视频响应没有装配 storage map。** 已补同用户的存储关联，gallery/video GET 与写响应均与通用媒体和 storage 读取一致。
3. **ISO 与毫秒时间误判。** 服务端接受带时区 ISO 或毫秒输入，统一回读毫秒；manager 2.5.1 仅对 verifiedAt 比较等价时间，其他字段仍严格核对，缺字段仍失败。Nova/Hikari 两份更新完成，各 103/103 测试通过。[补丁](patches/openclaw-storage-readback.patch)
4. **D1 绑定上限旧故障本轮未复现。** 当前存储和图片查询已按 90 个 ID 顺序分批。线上 115 条画廊列表正常；隔离测试覆盖 182 条并核对关联、顺序、用户隔离与错误传播。
5. **另一个实际故障：大图在前置框架被 413 拦截。** Vinext 将无 Action ID 的 multipart API POST 先按 progressive-action 上限解析，原默认仅 1 MiB，接口虽声明 20 MiB 也无法收到。已通过受支持的 `experimental.serverActions.bodySizeLimit` 设置 21 MiB 表单上限，接口保留 20 MiB 文件上限。编译后 Worker 的真实 multipart 1.2 MB 请求进入认证，超过 21 MiB 拒绝；生产有效 Token 的 20 MiB+1 文件返回路由 JSON 413，未创建上传操作。11,967,338 字节原图已真实上传成功。

通用 storage 接口的 verified 表示归档校验，不保证分享可用，允许 path-only 私有归档；下载器完整 MEGA 交付会另外要求 active 分享。旧记录默认 linked，未知数量/时间保持 null，不补造历史证据。

## 历史归档与原图

| 画廊 | source | 存储链接 | 已执行 |
| --- | --- | --- | --- |
| 814 | 80 | 38 | 原有 10 张 verified 原图、active 分享；PATCH 补六字段，展示图按原幂等键补齐 |
| 815 | 手动核验原图 | 46 | 现存文件 SHA-256 精确匹配网站 imageHash；不可覆盖上传、完整下载 SHA-256 校验、active 分享及关联 |
| 816 | 81 | 39 | 保留旧链接，用明确新 PATCH 键补证据；11.9 MB 原图展示成功，保留原 2 张派生图和封面 |
| 822 | 82 | 43 | 从真实 verified/active 记录创建关联并通过严格回读 |
| 823 | 86 | 44 | 创建关联；从精确 hash+thumbnail assetId 恢复真实上传回执，未重复上传 |
| 824 | 89 | 45 | Twitter 原图文件/索引 SHA 匹配；归档证据关联，大图展示已上传 |
| 825 | 90 | 47 | 自然查重匹配已有画廊，补原图及存储关联；未另建画廊 |
| 838 | 103 | 40、41 | 找到真实归档来源，两条历史链接保留并各补证据；两张 PNG 展示已上传，旧图/封面保留 |
| 839 | 104 | 42 | PATCH 原链接，对象 1、字节 849587、manifest 和时间匹配，画廊回读一致 |

815 的当前标题是 GIRLS BAND CRY - 主角团，旧报告中的作者名不能代替当前记录。其原图来自主机现存文件，并与网站 hash 精确匹配；没有虚构 social-downloader 的平台来源记录。私有执行清单保存在主机 `~/.openclaw/backups/yuexiaji-archive-recovery-20261002/manual-815-plan.json`。

两条旧 Twitter 失败来源 89/90 当前 error 为空、文件实体 hash 与索引一致、归档 verified、分享 active。旧 JS 404 已不构成当前未下载故障；本轮没有再次访问 Twitter 或重下载已有原图。

最终只读审计确认：上述九个画廊 images 分别为 10/1/3/1/1/2/2/4/1；八个真实 downloader source 均 imported，全部 file receipts 与原/派生 hash 可从画廊回读。所有本地原图实体 SHA-256、verified 归档、active 分享、六字段及 manifest 均匹配，gallery/storage 一致，已有封面、排序和 thumbnail 保留。脱敏审计在主机 `~/.openclaw/backups/yuexiaji-archive-recovery-20261002/final-sanitized-audit.json`。

投递证据单独核对：839/source104 有 first 模式 sent 1/1、uncertain 0、allSent=true；其他旧来源没有现存 delivery receipt，815 没有 downloader source 记录，不能推测 allSent。本轮没有重发用户消息或补造投递证据。

MEGA 的 `rclone lsjson --stat` 在缺失路径上可能成功返回 JSON null。下载器原先误判该结果；已将成功 null 映射 missing，非零失败仍保持 indeterminate，不把鉴权/网络错误当缺失。[实现与测试补丁](patches/openclaw-storage-null-stat.patch)已应用 Nova/Hikari：各 14/14 adapter 测试，实际缺失路径 missing、现有文件 present；Nova downloader 另有 71/71 与 manager integration 5/5 测试通过。

## 月下集番剧排期 Skill

- **AnimeSchedule：** 网站原本有有效加密 Token，Skill 只查本机 token 导致误报。新增固定 Agent 代理，在 Worker 内解密使用；Nova/Hikari × 两域名均 200，上游 119 条。两版本 Skill 分别更新 Nova 1.2.1/Hikari 1.3.1，29/31 项测试通过；标准 refresh 均成功，Bangumi 100、AniList 60、AnimeSchedule 83，9 条追番和原生命周期/回执保留。workerd 不支持 redirect:error，已改 manual 并拒绝非 2xx。[详细契约和补丁](OPENCLAW_AIRING_PROXY.md)

## 部署、备份与验证

用户指定的三个根配置命令已按顺序执行：远端迁移、列出表名、部署。`0024` 已应用，六列额外核对成功；后续两次部署均无待迁移。最终部署包含存储契约、排期代理和上传上限修复。

本地 D1 生产导出备份（1,689,317 字节）：`outputs/backups/yuexiaji-db-before-storage-20261002.sql`（忽略目录，含私有数据，勿提交）。主机备份目录：

- manager：`~/.openclaw/backups/yuexiaji-manager-2.5.0-before-storage-2.5.1-20261002/`
- downloader：`~/.openclaw/backups/social-image-downloader-before-stat-null-20261002/`
- airing：`~/.openclaw/backups/airing-agent-proxy-before-20261002/`（原文件、hash manifest、刷新前缓存）

最新构建、TypeScript、lint 均通过；网站 32/32 测试通过。独立审查未发现 P0/P1；生产验证覆盖两身份/域名、115 条列表、严格存储回读、真实大图上传和月下集番剧刷新。月下集补丁和受限恢复工具源码留在仓库，Token、私有分享 URL、原图、下载库与聊天内容未复制到提交文件。
