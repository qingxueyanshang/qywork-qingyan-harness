/**
 * 生成端口中 `art` 类别的实现：由对话模型写出一个 HTML 页面。
 *
 * 一次请求，不带工具：系统提示词规定页面的运行环境，用户消息依次是参考图、当前页面（在其上修改）与要求。
 * 回复中取出 `<!doctype html>` … `</html>`，按尺寸参数写入 viewport 标签后作为 `text/html` 产物返回，
 * 落盘、命名与版本由调用方（`generateMedia`、画布服务）按生成产物的规则处理。
 *
 * 失败的约定与生成端口相同：返回 `{ ok: false, message }`；用户停止时 signal 中止，异常原样抛出。
 */

import type { MediaCall, MediaCallResult } from '@qywork/agent'
import {
  buildAdapter,
  type ChatRequest,
  type ContentBlock,
  computeCost,
  ProviderError,
  type ProviderUsage,
  providerErrorMessage,
  STREAM_IDLE_TIMEOUT_MS,
} from '@qywork/ai'
import { ART_MENTION, artSizeOf, type MediaSpend, withArtViewport } from '@qywork/core'
import { type QyConfig, resolveModel } from './config.ts'

/** 页面可用的 three.js 附加模块。与 sidecar 的 `/art/lib/addons/` 一一对应，修改时两处同时修改。 */
export const ART_ADDONS = [
  'controls/OrbitControls.js',
  'geometries/RoundedBoxGeometry.js',
  'environments/RoomEnvironment.js',
] as const

const mention = (n: number) => ART_MENTION.image.replaceAll('{n}', String(n))

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
    `参考图按顺序依次称为「${mention(1)}」「${mention(2)}」……，要求中以同样的名称指代。`,
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

export async function generateArt(
  config: QyConfig,
  call: MediaCall,
  signal: AbortSignal,
  onSpend?: (spend: MediaSpend) => void,
): Promise<MediaCallResult> {
  const ref =
    call.provider !== undefined && call.model !== undefined
      ? { provider: call.provider, model: call.model }
      : undefined
  const target = resolveModel(config, ref)
  if (!target) {
    const choices =
      Object.entries(config.providers)
        .flatMap(([name, p]) => Object.keys(p.models).map((m) => `${name} / ${m}`))
        .join('、') || '（无）'
    return {
      ok: false,
      message: ref
        ? `未找到该对话模型：${ref.provider} / ${ref.model}。可选：${choices}`
        : `没有默认的对话模型，请通过 provider 与 model 指定。可选：${choices}`,
    }
  }
  if (!target.apiKey) {
    return { ok: false, message: `接口 ${target.provider} 未配置 API Key，请在设置 → 模型中填写` }
  }
  const adapter = buildAdapter({
    kind: target.kind,
    apiKey: target.apiKey,
    model: target.model,
    ...(target.baseUrl ? { baseUrl: target.baseUrl } : {}),
    ...(target.headers ? { headers: target.headers } : {}),
    ...(target.spec ? { spec: target.spec } : {}),
    ...(target.transport ? { transport: target.transport } : {}),
  })

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
    content.push({ type: 'text', text: `${mention(images)}：` })
    content.push({
      type: 'image',
      mimeType: input.mime,
      source: { kind: 'base64', data: Buffer.from(input.bytes).toString('base64') },
    })
  }
  content.push({ type: 'text', text: `要求：${call.prompt}` })
  const req: ChatRequest = {
    model: adapter.spec.id,
    system: [{ text: artSystemPrompt(size) }],
    messages: [{ role: 'user', content }],
    tools: [],
    maxOutputTokens: adapter.spec.maxOutputTokens,
    idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    signal,
  }

  const label = `${target.provider} / ${target.model}`
  let text = ''
  let usage: ProviderUsage | null = null
  let truncated = false
  try {
    for await (const ev of adapter.stream(req)) {
      if (ev.type === 'text_delta') text += ev.delta
      else if (ev.type === 'usage') usage = ev.usage
      else if (ev.type === 'done') truncated = ev.stopReason === 'max_tokens'
    }
  } catch (err) {
    if (signal.aborted || !(err instanceof ProviderError)) throw err
    return { ok: false, message: `${label}：${providerErrorMessage(err) ?? err.message}` }
  } finally {
    // 对话接口按 token 计费，回复不完整同样计费：收到用量即记账。
    if (usage) {
      const spend: MediaSpend = {
        kind: adapter.kind,
        provider: target.provider,
        model: target.model,
        output: 'art',
        quantity: usage.outputTokens,
        cost: computeCost(adapter.spec, usage),
        currency: adapter.spec.pricing.currency ?? 'USD',
        at: Date.now(),
      }
      onSpend?.(spend)
      call.onSpend?.(spend)
    }
  }

  const html = extractHtml(text)
  if (!html) {
    return {
      ok: false,
      message: truncated
        ? `${label}：输出达到上限，页面不完整`
        : `${label}：回复中没有完整的 HTML 文档`,
    }
  }
  return {
    ok: true,
    provider: target.provider,
    model: target.model,
    files: [{ bytes: new TextEncoder().encode(withArtViewport(html, size)), mime: 'text/html' }],
  }
}
