import { createSignal, onMount, Show } from 'solid-js'
import { holdPanelTab } from '../lib/store/index.ts'
import { IconRefresh } from './Icons.tsx'

/**
 * 浏览器预览页：一条地址栏加一个 iframe。用来看本机起的服务（dev server、
 * 自己写的页面），所以地址由用户给——**不猜端口**，猜出来的地址打不开比空着更费解。
 *
 * ## 只做「看」，不做浏览器的壳
 *
 * 没有前进 / 后退，也不回读当前地址：iframe 里是另一个源，`contentWindow.history`
 * 与 `location` 既读不到也调不动（同源策略）。做出来的按钮点了什么也不会发生（B5）。
 * 因此地址栏显示的是**你要求打开的那个地址**——在页面里点链接跳走之后它不跟着变。
 *
 * ## `sandbox` 不是可选的
 *
 * 不带它的话，被预览的页面一句 `top.location = ...` 就能把整个应用窗口导航走，
 * 那时除了重启没有出路。sandbox 默认禁掉顶层导航；`allow-scripts` +
 * `allow-same-origin` 只是让被预览的页面**保持它自己的源**（用得上 localStorage、
 * 调得动自己的接口），拿不到我们这一侧的任何东西。
 * **不要加 `allow-popups`**：新窗口会开在同一个 WebView 里，正好绕过上面那条。
 *
 * 桌面端另需 CSP 放行（`tauri.conf.json` 的 `frame-src`），少了它 iframe 直接空白，
 * 而且只在打包后的构建里空白——`tauri dev` 的页面由 vite 提供，不走那份 CSP。
 *
 * ## `allow` 与 `sandbox` 管的不是一件事
 *
 * `autoplay` 权限策略的默认允许列表是 `self`，跨源 iframe 拿不到——不给它，
 * 被预览页面里的 `<audio>` / `<video>` 带声播放会被拒（Web Audio 有用户手势时不受此限）。
 *
 * **地址栏只接受 http(s)**：`file:` 在 iframe 里被内核直接拒（`Not allowed to load
 * local resource`），CSP 放行也没用；本地 html 只能起个静态服务器再填它的地址。
 */

/**
 * 每一页记着的地址。**存在模块上而不是组件里**：收起面板会把组件卸载，地址跟着没了，
 * 再展开是一个空地址栏。这一页被关掉时才删（`holdPanelTab`）。
 *
 * 只记地址，不保页面状态：iframe 一旦从 DOM 里摘下来，再插回去就是重新加载，
 * 这是浏览器的行为，前端这一侧没有第二条路。
 */
const urls = new Map<string, string>()

/** 补协议：用户习惯只打 `localhost:3000`。预览的是本机服务，所以补 `http://`。 */
function normalize(raw: string): string {
  const s = raw.trim()
  if (!s) return ''
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`
}

export default function BrowserPanel(props: { id: string }) {
  const [url, setUrl] = createSignal(urls.get(props.id) ?? '')
  const [draft, setDraft] = createSignal(url())
  /**
   * 按过几次刷新。**同一个地址要重新加载只能把 iframe 整个换掉**：跨源的 iframe
   * 调不动 `location.reload()`，而把 `src` 重设成同一个字符串不会触发加载。
   */
  const [reloads, setReloads] = createSignal(0)

  /** keyed 的键。地址或刷新次数一变就是一个新对象 → iframe 重建 → 真的重新加载。 */
  const frame = () => (url() ? { src: url(), nth: reloads() } : null)

  const go = () => {
    const next = normalize(draft())
    setDraft(next)
    if (!next) return
    // 同一个地址再按回车 = 刷新。什么都不做的话那一下看起来像卡住了。
    if (next === url()) {
      setReloads((n) => n + 1)
      return
    }
    setUrl(next)
    urls.set(props.id, next)
  }

  let input!: HTMLInputElement
  onMount(() => {
    holdPanelTab(props.id, () => urls.delete(props.id))
    // 新开一页就是要打地址，焦点直接给它。已经有地址的（收起再展开）不抢焦点。
    if (!url()) input.focus()
  })

  return (
    <div class="web-panel">
      {/* 用 form 而不是在 input 上接 Enter：提交语义是白拿的，手机虚拟键盘上那颗
          「前往」也跟着能用。 */}
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
          // **不能用 `type="url"`**：那会开浏览器自带的校验，`localhost:3000`
          // 不带协议直接被判不合法，表单提交被静默拦下——表现是按回车没反应。
          type="text"
          spellcheck={false}
          placeholder="localhost:3000"
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
        />
        {/* 没有地址时禁用，而不是不渲染：那颗键一出没，地址栏里的输入框就跟着变宽变窄。 */}
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
