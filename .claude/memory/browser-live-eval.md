---
name: browser-live-eval
description: 浏览器控制的真实模型评测（无头 Edge 代替外壳，11 个场景）与真实 WebView2 外壳验证的位置与用法；改动浏览器控制后先对照再汇报
metadata:
  type: project
---

两套验证设施，2026-11-17 浏览器控制审查时建立：

- **真实模型评测**：`.tmp/browser-live/harness.ts`。无头 Edge 代替桌面外壳（`host.ts` 模拟宿主协议，`--popups drop|open` 模拟 Windows 外壳丢弃或打开新窗口），
  真实服务端与浏览器协调器，模型取隔离目录中复制的用户配置（`init-home.ts`）。11 个场景覆盖圆角按钮、无响应按钮、新窗口、确认框、隐藏上传框、固定侧栏滚动、
  禁用控件、列表重渲染、慢加载、长文本、新开页，判定由测试站点记录。
  用法：`QYWORK_HOME=.tmp/browser-live/home bun run .tmp/browser-live/harness.ts --root <仓库或 worktree> --label <名称> --popups open --parallel 3 --mode auto --tools safe`，
  结果与汇总在 `.tmp/browser-live/results/<名称>/summary.md`，两次评测的对照表：`bun run .tmp/browser-live/compare.ts <前标签[,补测]> <后标签>`。
  基线 worktree 按需创建：`git worktree add --detach .tmp/browser-live/base <基线提交>`，用完以「先解除链接再删除」的方式移除。不调用模型的检查：加 `--probe`（打开、观察、点击、每页截图）。
  并行运行时无头 Edge 偶发 `Page.captureScreenshot` 超时，用户账本中 317 次截图为 0 次超时，属于环境现象，两侧同样出现时不作为结论。
- **真实外壳验证**：`.tmp/popup-window-verify/verify.ts`。开发外壳编译时替换 identifier 与 devUrl，WebView2 数据目录与用户正在运行的 qywork 分开，
  不影响用户窗口；用于验证只在 WebView2 中出现的行为（`verify.ts` 新窗口，`verify-dialog.ts` 对话框与选择文件）。
  Tauri 插件的初始化脚本注入每个 WebView（包括内置浏览器的页），无头 Edge 中不存在这一来源，新窗口与 `confirm()` 的缺陷都只在真实外壳中出现。

**How to apply:** 改动浏览器工具、协调器或外壳的浏览器宿主之后，用评测对照改动前后（同一参数），用真实外壳验证 WebView2 专有的行为，再汇报。
评测消耗用户配置的模型额度。相关：[[diagnose-from-the-local-db]]、[[browser-click-lands-on-ancestor]]。
