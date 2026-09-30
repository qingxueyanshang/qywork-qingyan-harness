/**
 * 桌面外壳的调用桥：`__TAURI_INTERNALS__` 的唯一封装。
 *
 * **这个模块不许 import 本包内的任何模块。** 它必须是叶子：`ui.ts` 要用它，
 * 而 `connection.ts` 又 import 了 `ui.ts`——桥只要落在 `settings.ts` 那一侧，
 * 这条边就成环，表现是 `Cannot access 'QyClient' before initialization`。
 */

/**
 * 桌面外壳才有的能力：系统目录选择器、窗口控制。
 *
 * **换项目不在这个名单里**：服务端一次服务多个项目，换项目只是换一个 `?ws=`
 * 参数，浏览器和手机上照样能换。这里只剩「挑一个本机目录」需要外壳——
 * 那是系统对话框，Web 拿不到。
 */
export function isDesktopShell(): boolean {
  return typeof (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ === 'object'
}

interface TauriInternals {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>
  /** 把一个 JS 回调换成 Rust 那边能 emit 回来的数字句柄。 */
  transformCallback(cb: (payload: unknown) => void, once?: boolean): number
}

function internals(): TauriInternals | undefined {
  return (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ as TauriInternals | undefined
}

export function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const api = internals()
  if (!api) return Promise.reject(new Error('不在桌面端，用不了这个能力'))
  return api.invoke(cmd, args) as Promise<T>
}

/**
 * 订阅一个 Rust 侧 emit 的事件。
 *
 * 走 `plugin:event|listen` 这条内部通道，而不是引 `@tauri-apps/api`：
 * 前端这份代码桌面与手机共用，多引一个只有桌面能用的包，手机端的构建里
 * 就会多出一段永远不执行的代码（同 `lib.rs` 里那几个窗口命令的理由）。
 *
 * **不给退订**：现在的调用方都是「开一次听到进程结束」的常驻订阅，
 * 加一个没人调的退订接口等于宣称它该配对使用。真需要时再补。
 */
export function tauriListen<T>(event: string, handler: (payload: T) => void): Promise<void> {
  const api = internals()
  if (!api) return Promise.reject(new Error('不在桌面端，用不了这个能力'))
  const id = api.transformCallback((raw) => handler((raw as { payload: T }).payload))
  return api.invoke('plugin:event|listen', {
    event,
    target: { kind: 'Any' },
    handler: id,
  }) as Promise<void>
}

/**
 * 桌面外壳的系统拖放分发。
 *
 * **HTML5 的 `ondrop` 在桌面端不触发**：Tauri 的 `drag_drop_handler_enabled` 默认为真，OS 拖放被外壳截获，
 * 外壳 emit 的载荷里是绝对路径。事件是全窗的，按落点交给命中测试为真的那一个接收方（输入区、画布区）。
 *
 * 监听在模块级且只接一次：`tauriListen` 不提供退订。接收方挂载时登记、卸载时注销，事件照收，没有接收方就丢弃。
 */
export interface DropSink {
  hit(pos: { x: number; y: number }): boolean
  over(on: boolean): void
  paths(paths: string[], pos: { x: number; y: number }): void
}

const dropSinks = new Set<DropSink>()
let dropWired = false

export function registerDropSink(sink: DropSink): () => void {
  dropSinks.add(sink)
  wireShellDrop()
  return () => {
    dropSinks.delete(sink)
  }
}

function wireShellDrop(): void {
  if (dropWired) return
  dropWired = true
  type DropPayload = { paths?: string[]; position?: { x: number; y: number } }
  void tauriListen<DropPayload>('tauri://drag-over', (pl) => {
    for (const sink of dropSinks) sink.over(!!pl.position && sink.hit(pl.position))
  })
  void tauriListen<DropPayload>('tauri://drag-leave', () => {
    for (const sink of dropSinks) sink.over(false)
  })
  void tauriListen<DropPayload>('tauri://drag-drop', (pl) => {
    for (const sink of dropSinks) sink.over(false)
    const pos = pl.position
    if (!pos) return
    const target = [...dropSinks].find((sink) => sink.hit(pos))
    target?.paths(pl.paths ?? [], pos)
  })
}
