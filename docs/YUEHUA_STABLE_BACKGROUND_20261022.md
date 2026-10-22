# 背景滚动缩放修复（2026-10-22）

## 原因与修改
- 自定义背景原为 fixed + inset:0 + background-size:cover；在移动浏览器动态工具栏影响固定定位区域尺寸时，cover 会重新计算缩放与中心裁切。源码中没有背景随滚动主动缩放的脚本。
- 背景改用显式 100lvh 稳定高度，保留 100vh 兼容回退，bottom:auto 避免上下定位共同决定高度。背景仍居中铺满，在真实窗口大小/方向改变时按新视口重新适配。
- 只处理图片背景的尺寸，不改变其他面板的动态视口布局。若用户描述的是浏览器在页面顶端过度拖拽时对整个页面施加的系统拉伸效果，属于另一个需要实机区分的现象。
- 参考 https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/length#large_viewport_units ：大型视口单位在浏览器工具栏伸缩时保持稳定。

## 备份与回滚
- 修改前源码：3426daa5d733330fa5ce354c542739d153c7f8c4
- 完整源码备份：backup/pre-stable-background-20261022-3426daa
- 修改前 Worker：c56fd9ea-5de6-458a-b472-ae845a84d154
- 恢复时在新提交中恢复备份的 app/yuehua.css，经过 Actions 验证后发布；紧急恢复可回滚至上述 Worker。不要 reset/force push master。

## 验证
- 使用现有 Actions 完成类型检查、lint、构建和全部测试，再部署同次运行产物。
- 发布后可在浏览器只读检查背景元素 bottom:auto、显式稳定视口高度以及固定定位。桌面浏览器无法模拟手机地址栏的真实伸缩，不将其声称为手机实机验收。
