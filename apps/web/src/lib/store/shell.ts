/**
 * 桌面外壳的调用桥：`__TAURI_INTERNALS__` 的唯一封装。
 *
 * 本模块不得 import 本包内的任何模块，必须是叶子模块：`ui.ts` 依赖它，
 * 而 `connection.ts` 又 import 了 `ui.ts`；桥位于 `settings.ts` 一侧时，
 * 该依赖边形成环，报错为 `Cannot access 'QyClient' before initialization`。
 */

/**
 * 仅桌面外壳具备的能力：系统目录选择器、窗口控制。
 *
 * 切换项目不在此列：服务端同时服务多个项目，切换项目只需更换 `?ws=`
 * 参数，浏览器与手机上同样可以切换。此处只有选择本机目录需要外壳：
 * 它是系统对话框，Web 端无法调用。
 */
export function isDesktopShell(): boolean {
  return typeof (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ === 'object'
}

interface TauriInternals {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>
  /** 将 JS 回调转换为 Rust 侧可以通过 emit 回调的数字句柄。 */
  transformCallback(cb: (payload: unknown) => void, once?: boolean): number
}

function internals(): TauriInternals | undefined {
  return (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ as TauriInternals | undefined
}

export function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const api = internals()
  if (!api) return Promise.reject(new Error('该功能仅在桌面端可用'))
  return api.invoke(cmd, args) as Promise<T>
}

/**
 * 订阅一个 Rust 侧 emit 的事件。
 *
 * 经由 `plugin:event|listen` 内部通道，而不是引入 `@tauri-apps/api`：
 * 前端代码由桌面与手机共用，引入只有桌面可用的包会使手机端的构建
 * 包含一段永不执行的代码（与 `lib.rs` 中窗口命令的理由相同）。
 *
 * 不提供退订：现有调用方都是订阅一次并持续到进程结束的常驻订阅，
 * 提供无人调用的退订接口等于声明它应配对使用。需要时再添加。
 */
export function tauriListen<T>(event: string, handler: (payload: T) => void): Promise<void> {
  const api = internals()
  if (!api) return Promise.reject(new Error('该功能仅在桌面端可用'))
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
 * HTML5 的 `ondrop` 在桌面端不触发：Tauri 的 `drag_drop_handler_enabled` 默认为真，系统拖放被外壳截获，
 * 外壳 emit 的载荷中是绝对路径。事件作用于整个窗口，按落点交给命中测试为真的接收方（输入区、画布区）。
 *
 * 监听位于模块级且只注册一次：`tauriListen` 不提供退订。接收方挂载时登记、卸载时注销；监听持续接收事件，没有接收方时丢弃。
 */
export interface DropSink {
  /** 坐标统一为 CSS 像素，与 `getBoundingClientRect()`、画布定位使用同一坐标系。 */
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

function dropClientPosition(position: { x: number; y: number } | undefined) {
  if (!position) return
  // Tauri 提供物理像素；每次事件读取当前比例，适配跨屏移动和页面缩放。
  const scale = globalThis.devicePixelRatio ?? 1
  return { x: position.x / scale, y: position.y / scale }
}

function wireShellDrop(): void {
  if (dropWired) return
  dropWired = true
  type DropPayload = { paths?: string[]; position?: { x: number; y: number } }
  void tauriListen<DropPayload>('tauri://drag-over', (pl) => {
    const pos = dropClientPosition(pl.position)
    for (const sink of dropSinks) sink.over(!!pos && sink.hit(pos))
  })
  void tauriListen<DropPayload>('tauri://drag-leave', () => {
    for (const sink of dropSinks) sink.over(false)
  })
  void tauriListen<DropPayload>('tauri://drag-drop', (pl) => {
    for (const sink of dropSinks) sink.over(false)
    const pos = dropClientPosition(pl.position)
    if (!pos) return
    const target = [...dropSinks].find((sink) => sink.hit(pos))
    target?.paths(pl.paths ?? [], pos)
  })
}
