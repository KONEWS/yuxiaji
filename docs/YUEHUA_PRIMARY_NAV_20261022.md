# 主导航切换修复（2026-10-22）

## 问题与修改
- 手机端 ACGNM / 藏品库的未选中按钮仍使用 globals.css 的白色背景和 9px 圆角，而滑动高亮在按钮下层，造成移动时被遮挡、两侧形状不一致。
- 为 mobile-view-tabs 补齐统一圆角轨道和透明按钮外壳。滑动高亮由单独的伪元素绘制；无脚本时仍保留静态选中背景。
- 主导航的手机/电脑 DOM 同时存在。隐藏的导航组不再触发内容淡入动画，避免一次点击重复取消并重启动画。

## 备份与回滚
- 修改前 master：9b9280ab41bed711eda4c7b9d321608b361bfa1c
- 完整源码备份：backup/pre-primary-nav-motion-20261022-9b9280a
- 修改前最近成功生产源码：fdbb8006db50bcfe21ab9b822b7d050c5b99c183
- 生产源码备份：backup/production-pre-primary-nav-20261022-fdbb800
- 修改前最近成功 Worker：aec213fc-8132-4cd4-926d-e07d84859871
- 最新 master 的上一轮检查因 21 MiB 上传边界测试 fetch failed 未发布。保留其已有封面兼容改动，本轮须以最新源码通过完整检查后发布。
- 若只需撤销本次 UI 修复，在新提交中恢复源码备份的 app/yuehua.css 和 app/components/tracker/yuehua-motion.tsx，再通过 Actions 发布。紧急整站恢复可在 Cloudflare 回滚至上述 Worker，避免 reset/force push master。

## 验证范围
- GitHub Actions 执行类型检查、lint、构建及全部现有 Worker/API 测试后，使用同次运行的产物发布。
- 浏览器允许访问生产站点，但禁止打开本地 file 验证页；不将本地预览文件生成当成手机浏览器视觉测试。
- 发布后核对主导航按钮透明背景、圆角、滑块位置及来回切换。手机真实视觉效果须区分于桌面浏览器和隐藏 DOM 的样式核查。
