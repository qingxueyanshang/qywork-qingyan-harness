/**
 * Art 页面的宿主：`/art/host` 是固定的引导页，`/art/lib/*` 是页面可以引用的库文件。
 *
 * - 不校验配对令牌：内容是随应用发布的静态文件，与工作区无关。界面以 `sandbox="allow-scripts"` 的 iframe
 *   加载引导页，页面 HTML 由界面经 `postMessage` 传给引导页写入，地址中不带令牌。
 * - 不要改为 `srcdoc` 或 `blob:` 加载：这两种文档继承桌面端界面的 CSP（`default-src 'self'`），
 *   页面中的内联脚本被拒绝。由 sidecar 返回的文档不受该 CSP 约束。
 * - 库文件随 sidecar 的脚本一同分发（`with { type: 'file' }`），离线可用。页面源是不透明源，模块脚本按跨源请求加载，
 *   因此响应带 `Access-Control-Allow-Origin: *`。
 */

import { readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import {
  ART_MEDIA_REF_RE,
  artImportMap,
  artMediaRefs,
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

/**
 * 文件导入的绝对路径。源码运行时导入值已是绝对路径；构建产物中是相对脚本目录的路径，
 * 而 sidecar 的工作目录不是脚本目录，不要省略本步骤。
 */
const imported = (path: unknown): string => resolve(import.meta.dir, path as string)

/** 库文件：发布路径 → 文件的绝对路径。附加模块与系统提示词中的清单 `ART_ADDONS` 一一对应（测试核对）。 */
export const ART_LIBRARY: Readonly<Record<string, string>> = {
  'three.module.js': imported(threeModule),
  'three.core.js': imported(threeCore),
  'addons/controls/OrbitControls.js': imported(orbitControls),
  'addons/geometries/RoundedBoxGeometry.js': imported(roundedBox),
  'addons/environments/RoomEnvironment.js': imported(roomEnvironment),
  'modern-screenshot.js': imported(screenshot),
}

/**
 * 引导页：收到父窗口发来的 `qywork-art-load` 后，以其 HTML 替换整个文档。只接受父窗口的消息，只执行一次。
 * `media` 中每项的 `token` 在写入前替换为其 `blob` 的地址（界面 `loadArtPage` 提供的视频）。Blob 地址在沙箱内生成，
 * 与页面同源：截图库以 `crossOrigin = 'anonymous'` 重新载入视频后绘制到画布，跨源的地址无法读取画面。
 * `document.open` 不替换全局对象，写入前生成的地址在写入的页面中仍然有效。
 * 加载后向父窗口报告 `qywork-art-host`，父窗口据此发送页面。
 */
const HOST_PAGE = `<!doctype html><meta charset="utf-8"><script>
addEventListener('message', function load(e) {
  if (e.source !== parent || !e.data || e.data.type !== 'qywork-art-load') return
  removeEventListener('message', load)
  var html = e.data.html
  var media = e.data.media || []
  for (var i = 0; i < media.length; i++) {
    html = html.split(media[i].token).join(URL.createObjectURL(media[i].blob))
  }
  document.open()
  document.write(html)
  document.close()
})
parent.postMessage({ type: 'qywork-art-host' }, '*')
</script>`

/** 图片与视频扩展名对应的媒体类型，与 `ART_MEDIA_REF_RE` 接受的扩展名一致。 */
const MEDIA_MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
}

/**
 * 内部渲染（`browser/render.ts`）使用的页面：注入 importmap（库地址为 `lib`），并把按相对路径引用的工作区图片与视频
 * 替换为 data URL。引导页以 sidecar 的源加载，相对路径会按 `/art/host` 解析。视频在此用 data URL：内部渲染由 CDP 截屏，
 * 不经截图库，没有按帧重新载入。
 * 不要改为写入带令牌的文件地址：页面脚本可以读取它并调用接口。
 * `pagePath` 为页面文件的绝对路径；不存在或越出工作区的文件保持原样。
 */
export async function prepareArtForRender(
  html: string,
  pagePath: string,
  workspaceRoot: string,
  lib: string,
): Promise<string> {
  const page = relative(workspaceRoot, pagePath).replaceAll('\\', '/')
  const found = new Map<string, string>()
  for (const rel of artMediaRefs(html)) {
    const path = resolveArtRef(page, rel)
    const mime = MEDIA_MIME[rel.split('.').pop()?.toLowerCase() ?? '']
    if (!path || !mime) continue
    const bytes = await readFile(join(workspaceRoot, path)).catch(() => null)
    if (bytes) found.set(rel, `data:${mime};base64,${bytes.toString('base64')}`)
  }
  const inlined = html.replace(ART_MEDIA_REF_RE, (whole, lead: string, rel: string) => {
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
