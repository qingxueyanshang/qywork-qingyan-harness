/**
 * Art 页面的宿主：`/art/host` 是固定的引导页，`/art/lib/*` 是页面可以引用的库文件。
 *
 * - 不校验配对令牌：内容是随应用发布的静态文件，与工作区无关。界面以 `sandbox="allow-scripts"` 的 iframe
 *   加载引导页，页面 HTML 由界面经 `postMessage` 交给引导页写入，地址中不带令牌。
 * - 不要改为 `srcdoc` 或 `blob:` 加载：这两种文档继承桌面端界面的 CSP（`default-src 'self'`），
 *   页面中的内联脚本被拒绝。由 sidecar 返回的文档不受该 CSP 约束。
 * - 库文件随 sidecar 二进制内嵌（`with { type: 'file' }`），离线可用。页面源是不透明源，模块脚本按跨源请求加载，
 *   因此响应带 `Access-Control-Allow-Origin: *`。
 */

// @ts-expect-error 以文件路径形式导入的库文件，没有类型声明。
import screenshot from '../node_modules/modern-screenshot/dist/index.mjs' with { type: 'file' }
// @ts-expect-error 同上。
import threeCore from '../node_modules/three/build/three.core.js' with { type: 'file' }
// @ts-expect-error 同上。
import threeModule from '../node_modules/three/build/three.module.js' with { type: 'file' }
// @ts-expect-error 同上。
import orbitControls from '../node_modules/three/examples/jsm/controls/OrbitControls.js' with {
  type: 'file',
}
// @ts-expect-error 同上。
import roomEnvironment from '../node_modules/three/examples/jsm/environments/RoomEnvironment.js' with {
  type: 'file',
}
// @ts-expect-error 同上。
import roundedBox from '../node_modules/three/examples/jsm/geometries/RoundedBoxGeometry.js' with {
  type: 'file',
}

/** 引导页的路径。界面按 sidecar 地址拼接。 */
export const ART_HOST_PATH = '/art/host'
const LIB_PREFIX = '/art/lib/'

/** 库文件：发布路径 → 内嵌文件的路径。附加模块与系统提示词中的清单 `ART_ADDONS` 一一对应（测试核对）。 */
export const ART_LIBRARY: Readonly<Record<string, string>> = {
  'three.module.js': threeModule as string,
  'three.core.js': threeCore as string,
  'addons/controls/OrbitControls.js': orbitControls as string,
  'addons/geometries/RoundedBoxGeometry.js': roundedBox as string,
  'addons/environments/RoomEnvironment.js': roomEnvironment as string,
  'modern-screenshot.js': screenshot as string,
}

/**
 * 引导页：收到父窗口发来的 `qywork-art-load` 后，以其 HTML 替换整个文档。只接受父窗口的消息，只执行一次。
 * 加载后向父窗口报告 `qywork-art-host`，父窗口据此发送页面。
 */
const HOST_PAGE = `<!doctype html><meta charset="utf-8"><script>
addEventListener('message', function load(e) {
  if (e.source !== parent || !e.data || e.data.type !== 'qywork-art-load') return
  removeEventListener('message', load)
  document.open()
  document.write(e.data.html)
  document.close()
})
parent.postMessage({ type: 'qywork-art-host' }, '*')
</script>`

/** 处理 `/art/*`；其他路径返回 `null`。 */
export function serveArt(pathname: string): Response | null {
  if (pathname === ART_HOST_PATH) {
    return new Response(HOST_PAGE, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
    })
  }
  if (!pathname.startsWith(LIB_PREFIX)) return null
  const file = ART_LIBRARY[pathname.slice(LIB_PREFIX.length)]
  if (!file) return new Response('not found', { status: 404 })
  return new Response(Bun.file(file), {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-cache',
    },
  })
}
