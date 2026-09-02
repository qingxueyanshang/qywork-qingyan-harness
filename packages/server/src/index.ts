/**
 * `@qywork/server` 的对外面。**这里列的就是承诺，没列的就是内部实现。**
 * 具名导出，不用 `export *`，命名空间形式的 `export * as git` 同理（B6）；加一行
 * 之前先确认它真有包外调用点（B3）。事件总线、run 管理器、握手、文件接口都是包内
 * 的事，推出去等于宣称它们可以被单独复用。
 */

// 局域网候选地址：CLI 的 `qy serve` 要把它们连同二维码一起打出来
export { lanCandidates } from './pairing.ts'
// 桌面外壳异常拉起后的单次退出现场；CLI 解析后交回 serve 的恢复路径。
export { processExitObservationFromEnv } from './process-exit.ts'
// 服务入口
export { serve } from './server.ts'
