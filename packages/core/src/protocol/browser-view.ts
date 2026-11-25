/**
 * 远程查看连接（`/browser/view`）：桌面外壳以外的客户端查看并操作内置浏览器中的一个页面。
 *
 * - 连接地址带 `tabId` 与 `token`（配对令牌）；页面不存在、令牌无效时拒绝升级。
 * - 服务端 → 客户端：画面为二进制消息，前 4 字节（大端）为元数据 JSON 的字节数，其后依次为元数据（`BrowserViewFrame`）
 *   与 JPEG；通知为文本消息（`BrowserViewNotice`）。
 * - 客户端 → 服务端：文本消息（`BrowserViewInput`）。每显示一帧回复一次 `ack`：服务端在途的画面不超过
 *   `BROWSER_VIEW_INFLIGHT` 帧，帧率随网络自动降低，画面不在线路上排队。
 * - 坐标以页面视口的 CSS 像素为单位（元数据的 `width` 与 `height`），由客户端按显示尺寸换算。
 * - 查看期间页面视口按客户端的显示区域设定（`size`）：网页按客户端的宽度排版，而不是缩小电脑上的排版。电脑上同时显示该页时，
 *   页面在查看期间按客户端的尺寸显示。
 * - 不在画面中的界面由客户端代为显示（`BrowserViewPrompt`）：下拉框与日期、时间、颜色输入框的弹出层，网页的对话框，
 *   以及选择上传的文件。客户端的选择经 `answer`、`dialog`、`files` 回传。
 */

/** 查看连接的路径。 */
export const BROWSER_VIEW_PATH = '/browser/view'

/** 服务端在途（已发出、客户端尚未回复 `ack`）的画面上限。 */
export const BROWSER_VIEW_INFLIGHT = 2

/** 一帧的元数据。 */
export interface BrowserViewFrame {
  /** 页面视口的 CSS 像素尺寸，输入坐标以此为准。 */
  width: number
  height: number
}

/** 页面视口中的一个矩形，CSS 像素。 */
export interface BrowserViewRect {
  x: number
  y: number
  width: number
  height: number
}

/** 由客户端代为显示的弹出层（`id` 与回传的 `answer` / `files` 对应）。 */
export type BrowserViewPrompt =
  /**
   * 单选下拉框。`value` 与选项的 `value` 是选项的序号（字符串），不是网页中选项的值：网页中的值可以重复。
   * `group` 是所在分组的标题，不在分组中时为空串。
   */
  | {
      type: 'select'
      id: number
      rect: BrowserViewRect
      value: string
      options: { label: string; value: string; disabled: boolean; group: string }[]
    }
  /** 日期、时间与颜色输入框。值与 `min`、`max`、`step` 的格式与网页中该类型的输入框相同，未设定时为空串。 */
  | {
      type: 'input'
      id: number
      rect: BrowserViewRect
      kind: BrowserViewInputKind
      value: string
      min: string
      max: string
      step: string
    }
  /** 网页的 alert、confirm、prompt 与离开页面的确认。同一时刻至多一个，结果经 `dialog` 回传。 */
  | {
      type: 'dialog'
      kind: 'alert' | 'confirm' | 'prompt' | 'beforeunload'
      message: string
      defaultPrompt: string
    }
  /** 网页请求选择文件。`accept` 为输入框的 `accept` 属性原文。 */
  | { type: 'files'; id: number; multiple: boolean; accept: string }

/** 由客户端代为选择的输入框类型。 */
export type BrowserViewInputKind = 'date' | 'time' | 'datetime-local' | 'month' | 'week' | 'color'

export type BrowserViewNotice =
  /** 页面已关闭，或宿主已断开。连接随后关闭。 */
  | { type: 'closed' }
  /** 无法显示该页面（附加失败等），原因写入服务端日志。连接随后关闭。 */
  | { type: 'error' }
  | BrowserViewPrompt
  /** 先前的弹出层已失效（对话框已在电脑上处理、页面已导航），客户端收起它。 */
  | { type: 'dismiss' }
  /** 网页中当前选中的文字，变化时发送：客户端复制时写入系统剪贴板（浏览器自身的剪贴板与系统剪贴板不相通）。 */
  | { type: 'selection'; text: string }
  /** 鼠标所在元素的指针样式（CSS `cursor` 的计算值），变化时发送。 */
  | { type: 'cursor'; cursor: string }

export type BrowserViewInput =
  | { type: 'ack' }
  /**
   * 客户端显示区域的 CSS 像素尺寸与画面的像素比。查看期间页面视口按它设定，画面铺满显示区域；连接关闭后页面恢复原尺寸。
   * 收到之前不推送画面；宽或高为 0 表示显示区域不可见（所在的页未显示），停止推送，再次报告非 0 尺寸时恢复。
   */
  | {
      type: 'size'
      width: number
      height: number
      scale: number
      /** 画面的 JPEG 质量（1–100），不给出时为服务端的缺省值。本机显示时线路不受限，可取较高的质量。 */
      quality?: number
    }
  | {
      type: 'mouse'
      action: 'down' | 'up' | 'move'
      x: number
      y: number
      button: 'left' | 'middle' | 'right' | 'none'
      /** `down` 与 `up`：连续点击的次数，双击为 2。 */
      clickCount?: number
    }
  | { type: 'wheel'; x: number; y: number; dx: number; dy: number }
  /** 一次按键（按下与抬起）。`code` 为物理键码；`held` 为同时按住的修饰键的键码。 */
  | { type: 'key'; code: string; held: string[] }
  /** 输入文字，含输入法的确认结果。 */
  | { type: 'text'; text: string }
  /** `select` 或 `input` 弹出层的选择结果；`value` 为 `null` 表示取消。 */
  | { type: 'answer'; id: number; value: string | null }
  /** 对话框的结果：确定或取消，prompt 带输入的文字。 */
  | { type: 'dialog'; accept: boolean; text: string }
  /** 选择的文件：`uploads` 为上传接口返回的编号，空数组表示取消。 */
  | { type: 'files'; id: number; uploads: string[] }
