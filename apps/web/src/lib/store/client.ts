/**
 * 唯一的 `QyClient` 实例：REST 请求、指令、订阅与事件流共用这一条连接。
 *
 * 实例与事件流的回调分在两个模块：事件处理器调用各域模块，各域模块需要本实例，两者写在同一模块时
 * 各域模块只能经由该模块取得实例，形成引用环。回调由 `connection.ts` 在模块求值时经 `wireClient` 接入；
 * `store/index.ts` 转出 `connection.ts` 的导出，加载 store 入口即完成接入，入口在挂载后才调用 `client.connect()`。
 */

import { type ClientOptions, QyClient } from '../client.ts'

let wiring: ClientOptions | null = null

/** 回调尚未接入时抛错：此时触发的连接状态与拒绝回执没有接收方，不能静默丢弃。 */
function wired(): ClientOptions {
  if (!wiring) throw new Error('连接回调尚未接入：store/connection.ts 未加载')
  return wiring
}

export const client = new QyClient({
  onEvent: (frame) => wired().onEvent(frame),
  onState: (s, detail) => wired().onState(s, detail),
  onResync: () => wired().onResync(),
  onStreamChanged: () => wired().onStreamChanged(),
  onCapabilities: (caps) => wired().onCapabilities(caps),
  onBusy: (ids) => wired().onBusy(ids),
  onRejected: (frame) => wired().onRejected(frame),
  onRequest: (timing) => wired().onRequest(timing),
})

/** 接入事件流的回调。只由 `connection.ts` 调用。 */
export function wireClient(options: ClientOptions): void {
  wiring = options
}

/*
 * 热更新替换本模块之前，关闭旧连接。
 *
 * vite 会重新执行整个模块并创建第二个 `QyClient`，而上一个实例的 WebSocket 仍处于连接状态。
 * 服务端按连接注册订阅者（`handshake.ts` 以 `ws.data.id` 为 key），两条连接即两份
 * 相同的事件流，回调的却是同一个 store：正文每个 token 显示两次，末尾出现两条读数条。
 * 每修改一次代码即增加一条连接，连接数持续累积。
 *
 * 一键脚本启动的即为 dev 模式（`scripts/start.ps1` 两种模式都使用 vite dev server），
 * 因此该问题不只影响修改代码的人。此段无法由单元测试覆盖：`import.meta.hot`
 * 只在 vite 下存在，须实际执行一次热更新来验证。
 */
if (import.meta.hot) import.meta.hot.dispose(() => client.close())
