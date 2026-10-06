---
name: refresh-restore-testing
description: 刷新恢复的测试方法：以带查询串的路径重新导入模块模拟刷新；组件测试须在 afterEach 清空记录；性能对照构建把 sessionSignal 换成 createSignal
metadata:
  type: project
---

页面状态经 `apps/web/src/lib/session.ts` 的 `sessionSignal` 记录，`pagehide` 时写入 sessionStorage。测试与性能对比的做法：

- **模拟刷新**：先 `flushSession()`，再 `import('./store/ui.ts?refresh=N')`。Bun 为不同查询串建立新的模块实例，
  其中的信号按记录重新建立初值，与刷新后模块重新求值相同（`store.test.ts`「整页刷新后恢复页面状态」）。
  组件以「卸载、`flushSession`、重新挂载」模拟，挂载时只能从记录取得刷新前的状态。
- **组件测试的隔离**：记录在挂载之间保留，同一文件中前一条用例的展开、选中、草稿会进入下一条。
  挂载这类组件的测试文件在 `afterEach` 中执行 `flushSession(); sessionStorage.clear()`。
  2026-10-06 引入时 Composer、SidePanel、CanvasPanel 三个测试文件因此共失败 17 条。
- **验证测试有效**：临时把 `readSession` 改为一律返回 `undefined`，恢复类用例应全部失败，确认后改回。
- **性能对照**：把 `session.ts` 临时替换为 `sessionSignal = createSignal` 的版本，`vite build --outDir` 到 `.tmp`，
  与正式构建各起一个隔离 sidecar（见 [[probe-ui-with-isolated-instance]]），用同一个 Playwright 脚本对比。
  基线数据记录在 `ARCHITECTURE.md` 第 37 节。
- **易错点**：代码视图按像素恢复滚动会偏差数百像素（编辑器按估算行高建立），必须按行恢复；
  恢复的未提交草稿在编辑框无焦点时，不得因数据重新读取而被重建覆盖。
