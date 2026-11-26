/**
 * 生成端口中 `art` 类别的实现：由对话模型写出一个 HTML 页面。请求与重试经 `chat-generate/run.ts`。
 *
 * 用户消息依次是参考图、当前页面（在其上修改）与要求。
 * 回复中取出 `<!doctype html>` … `</html>`，按尺寸参数写入 viewport 标签后作为 `text/html` 产物返回，
 * 落盘、命名与版本由调用方（`generateMedia`、画布服务）按生成产物的规则处理。
 */

import { relative } from 'node:path'
import type { ContentBlock } from '@qywork/ai'
import { artSizeOf, type MediaSpend, withArtViewport } from '@qywork/core'
import type { MediaCall, MediaCallResult } from '@qywork/tools'
import { imageBlock, imageMention, runChatGeneration } from './chat-generate/run.ts'
import type { QyConfig } from './config.ts'

/** 页面可用的 three.js 附加模块。与 sidecar 的 `/art/lib/addons/` 一一对应，修改时两处同时修改。 */
export const ART_ADDONS = [
  'controls/OrbitControls.js',
  'geometries/RoundedBoxGeometry.js',
  'environments/RoomEnvironment.js',
] as const

/** 系统提示词。写运行环境与约定的定义；录制按页面时钟逐帧推进，动画的驱动方式因此写明。 */
export function artSystemPrompt(size: { w: number; h: number }): string {
  return [
    '你为一个无限画布写 HTML 页面。页面在画布节点中运行，可以截图、录制成视频，也可以直接作为前端设计稿。',
    '',
    '输出：一个完整的 HTML 文档，从 <!doctype html> 开始，到 </html> 结束，文档之外不写任何文字。',
    '',
    '运行环境：',
    `- 视口为 ${size.w}×${size.h} 像素。页面布满视口，不出现滚动条。`,
    '- 页面运行在离线环境中，网络地址无法访问。样式与脚本写在文档内。',
    "- 3D 使用 three.js：`import * as THREE from 'three'`。附加模块以 `three/addons/` 开头，可用的有 " +
      `${ART_ADDONS.join('、')}。importmap 已由运行环境提供，文档中不写 importmap。`,
    '- 录制时页面时钟逐帧推进：requestAnimationFrame 回调的时间参数、performance.now()、Date.now() 与 CSS 动画' +
      '都随之推进。动画优先由这几项驱动；setTimeout 与 setInterval 按真实时间执行，录制结果中的动画速度会不正确。',
    '',
    '术语：白模指只有几何形体、统一浅灰材质、带光照与阴影的场景，用于构图与走位。',
    `参考图按顺序依次称为「${imageMention(1)}」「${imageMention(2)}」……，要求中以同样的名称指代。`,
    '参考图后括号中的路径是该图相对页面的路径。页面中要显示参考图时，<img> 的 src 或 CSS 的 url() 直接写这个路径，' +
      '画布显示页面时载入该图片；不要把图片编码进页面，也不要用占位图形代替已提供的参考图。',
    '给出当前页面时，在它的基础上按要求修改，输出修改后的完整文档。',
  ].join('\n')
}

/** 回复中的 HTML 文档：从第一个 `<!doctype html` 或 `<html` 到最后一个 `</html>`。没有完整文档时为 `null`。 */
export function extractHtml(text: string): string | null {
  const start = text.search(/<!doctype html|<html[\s>]/i)
  const close = '</html>'
  const end = text.toLowerCase().lastIndexOf(close)
  if (start < 0 || end < start) return null
  return text.slice(start, end + close.length)
}

export function generateArt(
  config: QyConfig,
  call: MediaCall,
  signal: AbortSignal,
  onSpend?: (spend: MediaSpend) => void,
): Promise<MediaCallResult> {
  const size = artSizeOf(call.params)
  const content: ContentBlock[] = []
  let images = 0
  for (const input of call.inputs) {
    if (input.mime === 'text/html') {
      const page = new TextDecoder().decode(input.bytes)
      content.push({ type: 'text', text: `当前页面：\n\`\`\`html\n${page}\n\`\`\`` })
      continue
    }
    images += 1
    const rel = call.outputDir ? relative(call.outputDir, input.path).replaceAll('\\', '/') : ''
    content.push({
      type: 'text',
      text: rel ? `${imageMention(images)}（${rel}）：` : `${imageMention(images)}：`,
    })
    content.push(imageBlock(input))
  }
  content.push({ type: 'text', text: `要求：${call.prompt}` })
  return runChatGeneration(
    config,
    'art',
    call,
    {
      system: artSystemPrompt(size),
      content,
      reply(text, truncated) {
        const html = extractHtml(text)
        if (!html) {
          return {
            ok: false,
            message: truncated ? '输出达到上限，页面不完整' : '回复中没有完整的 HTML 文档',
          }
        }
        return {
          ok: true,
          file: { bytes: new TextEncoder().encode(withArtViewport(html, size)), mime: 'text/html' },
        }
      },
    },
    signal,
    onSpend,
  )
}
