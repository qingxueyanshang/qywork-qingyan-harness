---
name: flicker-probe-by-painted-frames
description: 排查点击切换时的闪烁：DOM 逐帧检测找候选，CDP 截帧定案；内置浏览器须在桌面外壳中截屏；模板克隆的图片挂起期间不加载
metadata:
  type: project
---

2026-11-24 排查「点击切换时内容先收缩再展开」所用的方法，脚本在 `.tmp/flicker/`（隔离实例的搭建见 [[probe-ui-with-isolated-instance]]）：

1. `detector.js` + `probe.mjs`（云端为 `cloud-probe.mjs`）：每帧记录各容器的元素数与高度，点击前后都存在、中间某帧缺失或元素数低于两端较小值一半即为候选。
   `frames.mjs` 逐帧打印指定区域的子元素摘要，用于判断空白帧是 Suspense 挂起还是页面自身的回退内容。
2. `screencast.mjs`（CDP `Page.startScreencast`，每帧一张）+ `ink.py`（正文区墨迹比例低于首尾较小值一半的帧）+ `sheet.py`（拼接变化的帧）定案。

**DOM 检测的假象**：检测在 `requestAnimationFrame` 中强制布局，早于浏览器对 `content-visibility: auto` 的判定和 ResizeObserver 回调，
会读取到 80px 占位行与尚未加上「展开全部」按钮的用户消息行，实际绘制帧中不存在。是否为真实闪烁以截取的帧为准。

**反过来也成立**：`content-visibility: auto` 本身会造成真实的空白帧。新内容整体替换旧内容后，底部跟随在同一帧内移动视口，
新露出的条目被跳过绘制；对照实验（注入样式取消该属性）6/6 → 0/6。会话流以 `.settling` 在切换后第一帧完整渲染。

**Suspense 挂起期间 effect 推迟执行**：在 `createEffect` / `onMount` 中发起的读取，要等挂起解除后才开始。
接入 `HoldSwitch` / `suspendUntil` 的组件，首次读取必须在创建时发起（`createResource` 或 `createComputed`）。

**区域显示之后创建的组件不挂起**：`suspendUntil` 经 `RegionPending` 判断所在区域（`HoldSwitch` 的一项、`HoldBoundary`）是否已显示，
已显示时不挂起；懒加载组件外用 `HoldBoundary`，不要直接包 Suspense。已显示的 Suspense 再次挂起时整体换为后备内容。

**内置浏览器与 HTML 预览只能在桌面外壳中判定**：原生子视图不在 CDP 截取的画面中。`shell-probe.mjs` 启动隔离服务端、vite 与另行编译的外壳，
`wincap.ps1` 按进程找到主窗口、置顶后截取客户区。外壳以 `TAURI_CONFIG` 替换 identifier 隔离数据目录，不要设置 `WEBVIEW2_USER_DATA_FOLDER`：
它同时作用于浏览器宿主的子视图，子视图创建失败（0x8007139F）。原生子视图与 DOM 分两路上屏：摆放在 effect 中发出，移走等到第二帧。

**JSX 模板克隆的元素属于模板的文档**：Suspense 挂起期间 `<img>` 不加载（插入模板克隆的父元素后加载中断），区域显示后才开始；
需要在挂起期间加载的资源在页面文档中另建（`new Image()`）。

**Why:** 只看 DOM 检测会把假象当成缺陷继续修改，只看截帧又无法确定是哪个容器。
**How to apply:** 先运行 DOM 检测列出候选，对剩余候选截帧复核；验证修法时同一脚本修复前后各运行一次。
