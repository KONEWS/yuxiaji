# 星期选中态与二级菜单滚动条（2026-10-21）

## 修改
- 首页星期选中态使用深色文字、可读的日期小字和淡紫玻璃底；保留胶囊切换动画，不恢复蓝色选中框。
- 二级弹窗、侧栏、标签列表、详情简介、安全面板及下拉菜单的滚动条统一为细窄圆角灰紫色，悬停加深。
- Chromium/WebKit 使用透明轨道与渐变滑块；Firefox 使用标准细滚动条及统一颜色。原来隐藏滚动条的横向标签栏保留隐藏。高对比模式使用系统颜色。

## 发布与回滚
- 修改前源码：b364081bcf4c7b394ab2a98152fba22fea632065
- 完整源码备份：backup/pre-weekday-scrollbars-20261021-b364081
- 修改前 Worker：ba7d9215-391f-4f2d-8824-c929d2a4fbcb
- 通过功能分支检查后合并 master，使用同一次 GitHub Actions 的已验证产物发布。
- 紧急恢复可在 Cloudflare 将生产 Worker 回滚至上述版本；持久恢复在新的提交中恢复备份中的 app/yuehua.css 与 app/yuehua-secondary.css，再通过 Actions 发布。不要 reset/force push master。
- 本次只修改展示 CSS，不调整数据库、收藏内容、凭据或认证。

## 验证
- 生产发布必须等待对应 Actions 类型检查、lint、构建、66 项测试与发布后协议验证成功。
- 本次本地执行器出现 sandbox provisioning 锁目录拒绝访问，无法启动本地构建及浏览器；以 GitHub Actions 的实际日志为准，不将源码审阅称为浏览器实测。
