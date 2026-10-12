# 本次历史画廊恢复工具

`recover-gallery-import.py` 是 2026-10-02 排查中使用的受限一次性恢复工具。
历史恢复已完成；保留脚本用于审阅和同一批来源的幂等续跑，不是通用导入 CLI。

运行位置是原 OpenClaw 主机。它依赖该主机 Nova 已安装的
`social-image-downloader 1.5.0`、`yuexiaji-manager 2.5.1`、现有运行态下载库、
Agent 配置和凭据。不要在源码归档、ZIP 副本或不同版本的 Skill 上运行。
只有 source `80 / 81 / 86 / 89 / 90 / 103` 可以传入；其画廊分别是
`814 / 816 / 823 / 824 / 825 / 838`。815 是单独核实的本机文件归档，
没有伪造下载器 source，因此不由此工具处理。

默认只读，查看现有来源状态、关联画廊和导入回执数量：

```bash
python3 recover-gallery-import.py 80
```

按同一来源和原有幂等键执行最多三次上传尝试：

```bash
python3 recover-gallery-import.py 80 --execute --max-uploads 3
```

它先建立主机私有备份目录（0700），使用 SQLite backup API 保存一致的数据库备份
（0600），再记录私有画廊快照及逐批结果（0600）。默认目录是
`~/.openclaw/backups/yuexiaji-archive-recovery-20261002/`；可用 `--audit-dir`
指定另一处主机私有目录。快照和完整日志可能包含分享 URL，必须留在主机，不能复制到仓库。

仅当画廊已有完全相同的上传字节 hash 且缩略图 URL 提供真实 asset ID 时，脚本会恢复缺失的
本地导入回执。其余项交给已安装 Skill 处理，新增图片不会重新指定现有封面；每批都会核对
原图片 ID、hash、缩略图、封面和顺序。未完成或报错时先看私有结果日志，保留原幂等键，
不要删除原图、重建任务或盲目更换键。

工具不会投递任何消息、重新下载原图、创建分享、更新文件存储链接或删除图片。
标准输出只给脱敏摘要；执行日志、SQLite、分享 URL、Token、Cookie、原图和派生图不得提交。
