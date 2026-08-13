/**
 * `@qywork/server` 的对外面。
 *
 * **这里列的就是承诺，没列的就是内部实现。** 之前六个模块走 `export *`
 * 外加一个 `export * as git`，把二十来个符号推到包外——而真正有包外调用点的
 * 只有下面两个。事件总线、run 管理器、握手、文件接口都是这个包内部的事，
 * 推出去只会让人以为它们可以被单独复用。
 *
 * `export * as git` 一并删了：CLI 只 import `{ lanCandidates, serve }`，
 * 那个命名空间包外零引用。
 *
 * 加新的对外符号时：先确认它真的有包外调用点，再往下面加一行。
 */

// 局域网候选地址：CLI 的 `qy serve` 要把它们连同二维码一起打出来
export { lanCandidates } from './pairing.ts'
// 服务入口
export { serve } from './server.ts'
