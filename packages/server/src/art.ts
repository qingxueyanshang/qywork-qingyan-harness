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

import { readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import {
  ART_IMAGE_REF_RE,
  artImageRefs,
  artImportMap,
  insertAfterHead,
  resolveArtRef,
} from '@qywork/core'

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
/** 库文件目录的路径，importmap 指向它。 */
export const ART_LIB_PATH = '/art/lib/'

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

/** 图片扩展名对应的媒体类型，与 `ART_IMAGE_REF_RE` 接受的扩展名一致。 */
const IMAGE_MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
}

/**
 * 内部渲染（`browser/render.ts`）使用的页面：注入 importmap（库地址为 `lib`），并把按相对路径引用的工作区图片
 * 换成 data URL。引导页以 sidecar 的源加载，相对路径会按 `/art/host` 解析。
 * 不要改为写入带令牌的文件地址：页面脚本可以读取它并调用接口。
 * `pagePath` 为页面文件的绝对路径；不存在或越出工作区的图片保持原样。
 */
export async function prepareArtForRender(
  html: string,
  pagePath: string,
  workspaceRoot: string,
  lib: string,
): Promise<string> {
  const page = relative(workspaceRoot, pagePath).replaceAll('\\', '/')
  const found = new Map<string, string>()
  for (const rel of artImageRefs(html)) {
    const path = resolveArtRef(page, rel)
    const mime = IMAGE_MIME[rel.split('.').pop()?.toLowerCase() ?? '']
    if (!path || !mime) continue
    const bytes = await readFile(join(workspaceRoot, path)).catch(() => null)
    if (bytes) found.set(rel, `data:${mime};base64,${bytes.toString('base64')}`)
  }
  const inlined = html.replace(ART_IMAGE_REF_RE, (whole, lead: string, rel: string) => {
    const data = found.get(rel)
    return data ? `${lead}${data}` : whole
  })
  return insertAfterHead(inlined, artImportMap(lib))
}

/** 处理 `/art/*`；其他路径返回 `null`。 */
export function serveArt(pathname: string): Response | null {
  if (pathname === ART_HOST_PATH) {
    return new Response(HOST_PAGE, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
    })
  }
  if (!pathname.startsWith(ART_LIB_PATH)) return null
  const file = ART_LIBRARY[pathname.slice(ART_LIB_PATH.length)]
  if (!file) return new Response('not found', { status: 404 })
  return new Response(Bun.file(file), {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-cache',
    },
  })
}
