import { createSignal, onMount, Show } from 'solid-js'
import { panelTabUrl, setPanelTabUrl } from '../lib/store/index.ts'
import { IconRefresh } from './Icons.tsx'

/**
 * 网页预览页：一个地址栏与一个 iframe。用于查看本机启动的服务（dev server、
 * 用户自行编写的页面），因此地址由用户提供。**不推测端口**：推测出的地址无法打开时比留空更难理解。
 *
 * **它不是内置浏览器。** 内置浏览器由桌面外壳的宿主承载，
 * 有登录状态且可由 AI 操作（`BrowserPanel.tsx`）；本页只能查看。
 *
 * **只提供查看，不实现浏览器外壳。** 没有前进 / 后退，也不读取当前地址：iframe 中是另一个源，
 * `contentWindow.history` 与 `location` 既无法读取也无法调用（同源策略）。这类按钮点击后不会产生
 * 任何效果（B5）。因此地址栏显示的是**请求打开的地址**，在页面中点击链接跳转后它不随之变化。
 *
 * **`sandbox` 不可省略。** 不设置时，被预览的页面只需执行 `top.location = ...` 就能使整个应用窗口
 * 跳转，此时只能重启应用。sandbox 默认禁止顶层导航；`allow-scripts` + `allow-same-origin` 只是
 * 让被预览的页面**保持其自身的源**（可使用 localStorage、可调用自身的接口），无法取得宿主一侧的任
 * 何数据。**不要添加 `allow-popups`**：新窗口会在同一个 WebView 中打开，恰好绕过上述限制。
 *
 * 桌面端还需要 CSP 放行（`tauri.conf.json` 的 `frame-src`），缺少时 iframe 直接显示空白，
 * 且只在打包后的构建中显示空白：`tauri dev` 的页面由 vite 提供，不受该 CSP 约束。
 *
 * **`allow` 与 `sandbox` 控制的不是同一件事。** `autoplay` 权限策略的默认允许列表是 `self`，跨源 iframe
 * 无法取得该权限：不授予时，被预览页面中的 `<audio>` / `<video>` 有声播放会被拒绝（Web Audio 在有用户手势时不
 * 受此限）。
 *
 * **地址栏只接受 http(s)**：`file:` 在 iframe 中被内核直接拒绝（`Not allowed to load
 * local resource`），CSP 放行也无效；本地 html 只能先启动静态服务器，再填写其地址。
 */

/** 补全协议：用户通常只输入 `localhost:3000`。预览的是本机服务，因此补全 `http://`。 */
function normalize(raw: string): string {
  const s = raw.trim()
  if (!s) return ''
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`
}

export default function PreviewPanel(props: { id: string }) {
  // 地址保存在页签记录上，不保存在组件中：收起面板时组件即被卸载（见 `PanelTab.url`）。
  const url = () => panelTabUrl(props.id)
  const [draft, setDraft] = createSignal(url())
  /**
   * 刷新次数。**同一地址要重新加载只能整体替换 iframe**：跨源 iframe
   * 无法调用 `location.reload()`，而把 `src` 重设为相同字符串不会触发加载。
   */
  const [reloads, setReloads] = createSignal(0)

  /** keyed 的键。地址或刷新次数变化即生成新对象 → iframe 重建 → 重新加载。 */
  const frame = () => (url() ? { src: url(), nth: reloads() } : null)

  const go = () => {
    const next = normalize(draft())
    setDraft(next)
    if (!next) return
    /*
     * 其他 scheme 在此处拒绝，不要交给 iframe。
     *
     * 交给 iframe 时，地址仍会填入、iframe 仍会创建，随后内核直接拒绝加载：
     * 用户看到的是一块没有任何说明的空白（实测 `file:` 只在控制台输出一句
     * `Not allowed to load local resource`，`ftp:` 连这一句也没有）。
     * 使用输入框自身的校验气泡提示，不另设错误区域。
     */
    if (!/^https?:\/\//i.test(next)) {
      input.setCustomValidity('只能打开 http / https 地址')
      input.reportValidity()
      return
    }
    // 对同一地址再次按回车等同于刷新。不处理时此次回车没有任何反馈。
    if (next === url()) {
      setReloads((n) => n + 1)
      return
    }
    setPanelTabUrl(props.id, next)
  }

  let input!: HTMLInputElement
  onMount(() => {
    // 新开的页签需要输入地址，焦点直接交给输入框。已有地址的页签（收起后再展开、从正文中打开）不获取焦点。
    if (!url()) input.focus()
  })

  return (
    <div class="web-panel">
      {/* 使用 form 而不是在 input 上监听 Enter：提交语义由表单自带，手机虚拟键盘上的
          「前往」键也随之可用。 */}
      <form
        class="web-bar"
        onSubmit={(e) => {
          e.preventDefault()
          go()
        }}
      >
        <input
          class="web-url"
          ref={input}
          // 不能使用 `type="url"`：它会启用浏览器自带的校验，`localhost:3000`
          // 因缺少协议被判定为不合法，表单提交被静默拦截，按回车没有任何反应。
          type="text"
          spellcheck={false}
          placeholder="localhost:3000"
          value={draft()}
          // 每次输入都必须清除校验状态。保留非空的 customValidity 时，原生校验会
          // 直接拦截提交，`onSubmit` 不再执行，用户改正地址后也无法提交。
          onInput={(e) => {
            setDraft(e.currentTarget.value)
            e.currentTarget.setCustomValidity('')
          }}
        />
        {/* 没有地址时禁用，而不是不渲染：按钮出现与消失会使地址栏输入框随之变宽或变窄。 */}
        <button
          class="icon-btn"
          type="button"
          aria-label="刷新"
          data-tip="刷新"
          disabled={!url()}
          onClick={() => setReloads((n) => n + 1)}
        >
          <IconRefresh size={14} />
        </button>
      </form>

      <Show when={frame()} keyed>
        {(f) => (
          <iframe
            class="web-frame"
            src={f.src}
            title="预览"
            sandbox="allow-scripts allow-same-origin allow-forms"
            allow="autoplay; fullscreen"
          />
        )}
      </Show>
    </div>
  )
}
