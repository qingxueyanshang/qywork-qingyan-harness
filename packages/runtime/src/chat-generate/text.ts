/**
 * 生成端口中 `text` 类别的实现：由对话模型写出一段文本，作为 `text/markdown` 产物返回。请求与重试经 `run.ts`。
 *
 * 用户消息依次是编号的参考图与参考视频（按输入顺序）与要求。要求中引用的文本卡已由调用方展开为正文（画布 `compilePrompt`）。
 * 输出达到上限时返回已写出的部分并附带警告：不完整的文本仍可阅读与修改，与页面不同。
 */

import type { ContentBlock } from '@qywork/ai'
import type { MediaCall, MediaCallResult } from '@qywork/tools'
import type { QyConfig } from '../config.ts'
import { type ChatDeps, imageBlock, imageMention, runChatGeneration, videoMention } from './run.ts'

/** 系统提示词：写明结果的用途与形式，以及参考素材的名称。 */
export const TEXT_SYSTEM_PROMPT = [
  '你为一个无限画布写文本。结果保存为一个 Markdown 文件，显示在画布的文本卡中，也作为其他生成卡（图片、视频、页面、文本）的提示词。',
  '',
  '输出即该文件的全文：从所要求文本的第一句开始，到其最后一句结束。可使用 Markdown。',
  `参考图按顺序依次称为「${imageMention(1)}」「${imageMention(2)}」……，` +
    `参考视频依次称为「${videoMention(1)}」「${videoMention(2)}」……，要求中以同样的名称指代。` +
    '参考视频以视频本身或按画面变化抽取的若干帧给出，帧前写明该帧在视频中的时刻。',
].join('\n')

export function generateText(
  config: QyConfig,
  call: MediaCall,
  signal: AbortSignal,
  deps: ChatDeps,
): Promise<MediaCallResult> {
  const content = (video: (input: MediaCall['inputs'][number]) => ContentBlock[]) => {
    const blocks: ContentBlock[] = []
    let images = 0
    for (const input of call.inputs) {
      if (input.role === 'video') {
        blocks.push(...video(input))
        continue
      }
      images += 1
      blocks.push({ type: 'text', text: `${imageMention(images)}：` }, imageBlock(input))
    }
    blocks.push({ type: 'text', text: `要求：${call.prompt}` })
    return blocks
  }
  return runChatGeneration(
    config,
    'text',
    call,
    {
      system: TEXT_SYSTEM_PROMPT,
      content,
      reply(text, truncated) {
        const body = text.trim()
        if (!body) return { ok: false, message: '回复为空' }
        return {
          ok: true,
          file: { bytes: new TextEncoder().encode(`${body}\n`), mime: 'text/markdown' },
          ...(truncated ? { warning: '输出达到上限，文本不完整' } : {}),
        }
      },
    },
    signal,
    deps,
  )
}
