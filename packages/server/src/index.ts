/**
 * `@qywork/server` 的对外接口。**此处列出的即对外承诺，未列出的均为内部实现。**
 * 使用具名导出，不用 `export *`，命名空间形式的 `export * as git` 同样不用（B6）；新增导出
 * 前先确认它确有包外调用方（B3）。事件总线、run 管理器、握手、文件接口都属于包内
 * 实现，导出它们等于声明它们可以被单独复用。
 */

// 局域网候选地址：CLI 的 `qy serve` 要把它们连同二维码一起输出
export { lanCandidates } from './pairing.ts'
// 桌面外壳异常重启后的单次退出信息；CLI 解析后交给 serve 的恢复路径。
export { processExitObservationFromEnv } from './process-exit.ts'
// 服务入口
export { serve } from './server.ts'
