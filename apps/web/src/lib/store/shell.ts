/**
 * 桌面外壳的调用桥：`__TAURI_INTERNALS__` 的唯一封装。
 *
 * 本模块不得 import 本包内的任何模块，必须是叶子模块：`ui.ts`、`settings.ts` 与 `actions.ts`
 * 都依赖它，它再依赖本包内的模块会形成引用环，环上的模块会取得尚未初始化的导出。
 */

/**
 * 仅桌面外壳具备的能力：系统目录选择器、窗口控制。
 *
 * 切换项目不在此列：服务端同时服务多个项目，切换项目只需更换 `?ws=`
 * 参数，浏览器与手机上同样可以切换。此处只有选择本机目录需要外壳：
 * 它是系统对话框，Web 端无法调用。
 *
 * 判据是当前 WebView 的标签属于外壳的界面窗口（`SHELL_WEBVIEWS`），不是 `__TAURI_INTERNALS__` 是否存在：
 * 外壳向它创建的每个 WebView 注入该对象，包括内置浏览器打开的外部网页；那些 WebView 没有任何命令权限，
 * 在其中打开的本界面（如远程访问的页面）按桌面端运行时，每次调用都被权限检查拒绝。
 */
export function isDesktopShell(): boolean {
  const label = internals()?.metadata?.currentWebview?.label
  return label !== undefined && SHELL_WEBVIEWS.has(label)
}

/**
 * 外壳界面窗口的 WebView 标签，与 `apps/desktop/src-tauri/capabilities/` 中授权的 `webviews` 一致：
 * 主窗口与桌面宠物的两个窗口。新增授权的界面窗口时两处一并修改。
 */
const SHELL_WEBVIEWS: ReadonlySet<string> = new Set(['main', 'pet', 'pet-box'])

interface TauriInternals {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>
  /** 将 JS 回调转换为 Rust 侧可以通过 emit 回调的数字句柄。 */
  transformCallback(cb: (payload: unknown) => void, once?: boolean): number
  /** 外壳在创建 WebView 时注入。 */
  metadata?: { currentWebview?: { label?: string } }
}

function internals(): TauriInternals | undefined {
  return (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ as TauriInternals | undefined
}

export function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const api = internals()
  if (!api || !isDesktopShell()) return Promise.reject(new Error('该功能仅在桌面端可用'))
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
  if (!api || !isDesktopShell()) return Promise.reject(new Error('该功能仅在桌面端可用'))
  const id = api.transformCallback((raw) => handler((raw as { payload: T }).payload))
  return api.invoke('plugin:event|listen', {
    event,
    target: { kind: 'Any' },
    handler: id,
  }) as Promise<void>
}

/**
 * 向指定窗口发送一个事件。主窗口向桌面宠物窗口推送状态、宠物窗口回传操作都经由此处。
 * 理由同 `tauriListen`：经内部通道，不引入 `@tauri-apps/api`。
 */
export function tauriEmitTo(label: string, event: string, payload: unknown): Promise<void> {
  const api = internals()
  if (!api || !isDesktopShell()) return Promise.reject(new Error('该功能仅在桌面端可用'))
  return api.invoke('plugin:event|emit_to', {
    target: { kind: 'WebviewWindow', label },
    event,
    payload,
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

/**
 * 只在桌面外壳中监听：系统拖放只由外壳发出。手机与浏览器中的界面同样登记接收方，在此处监听会得到
 * 三个无人处理的拒绝。
 */
function wireShellDrop(): void {
  if (dropWired || !isDesktopShell()) return
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
