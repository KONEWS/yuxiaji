# OpenClaw 放送信源接入

检查日期：2026-10-02（Asia/Hong_Kong）。

`yuexiaji-anime-airing` 的第三个信源 AnimeSchedule 已恢复。网站账户集成中原本有加密保存的 Application Token，但 Skill 原先只查本机环境变量或 Token 文件，因此错误地报告未配置。现在缺少本机 Token 时，Skill 使用 manager 的 Agent 认证调用网站固定代理；第三方凭据只在 Worker 内解密和使用。

## Agent API

- `GET /api/agent/anime/airing?source=animeschedule`，需现有 Nova/Hikari Bearer 认证和 `airing:read` 权限。
- `GET /api/agent` 的 `endpoints.animeAiring` 提供该地址。
- `source` 仅支持 `animeschedule`，省略时也使用该来源。
- 可选 `tz` 使用有效 IANA 时区，默认 `Asia/Tokyo`。`week` 和 `year` 必须一起提供，分别限制为 1–53、2000–2200。未知或重复参数返回 400。
- 成功返回 `{ok:true,source:"animeschedule",credentialSource:"settings"|"environment",items:[...],fetchedAt:ISO时间}`。日程条目只返回 `id/route/title/english/romaji/native/episodeDate/episodeNumber/airType/status`，不存在的字段省略。
- 响应使用 `Cache-Control: no-store`。缺失或无法解密的凭据返回 503；上游认证、连接或响应错误返回 502，不转发上游错误正文、Token 或密文。

代理只请求固定的 AnimeSchedule `/api/v3/timetables/raw`，不接受任意上游 URL，也不跟随重定向。Cloudflare workerd 的 `fetch` 不实现 `redirect:"error"`；这里使用 `manual` 并拒绝所有非 2xx 状态。测试通过真实 workerd Request 校验此兼容性。

上游字段与查询参数见 [AnimeSchedule 官方文档](https://animeschedule.net/api/v3/documentation/anime)。

## Skill 更新与恢复

两份 Skill 的原版本不同，因此分别维护补丁：

| Agent | 升级 | 补丁 | 离线测试 |
| --- | --- | --- | --- |
| Nova | 1.2.0 → 1.2.1 | [Nova 补丁](patches/openclaw-airing-nova-proxy.patch) | 29/29 |
| Hikari | 1.3.0 → 1.3.1 | [Hikari 补丁](patches/openclaw-airing-hikari-proxy.patch) | 31/31 |

补丁来自主机备份与实际部署文件的差异，包含脚本、自测及 Skill 说明；不包含凭据、缓存状态或私人分享链接。Hikari 的深夜放送日边界功能保持原样。本机显式 Application Token 的直连路径也保持可用。

从各 Agent 的 `skills/` 目录应用对应补丁时使用 `patch -p1 --dry-run`，确认原版本匹配后再移除 `--dry-run` 执行。已更新到上述版本的部署不要重复应用。原文件、SHA-256 manifest 和刷新前缓存备份位于主机 `~/.openclaw/backups/airing-agent-proxy-before-20261002/`。

标准命令 `python3 .../scripts/anime_airing.py --json refresh --agent nova` 和 `--agent hikari` 均已执行成功。两份 Skill 共用默认缓存目录，保留原有生命周期核验及渠道回执，没有发送消息。

## 实际验证

- 两身份、两个网站入口代理均返回 HTTP 200，`credentialSource=settings`，上游原始日程 119 条。
- Skill 过滤无效/过旧时间后，AnimeSchedule 可用日程 83 条；Bangumi 100 条、AniList 60 条，三个信源健康状态均为 `ok`。
- 月下集追番 9 条；既有放送生命周期核验 9 条，待核验 0 条。没有改变媒体的 `watching` 状态。
- 网站隔离 Worker/D1 的 5 项测试验证认证、加密凭据、查询限制、固定上游和错误脱敏；对应 TypeScript 与 ESLint 检查通过。
