/**
 * 生成端口的实现：选模型、由输入推操作、按目录校验参数、调生成接口。读输入与写产物在工具里（`tools/generate.ts`）。
 *
 * 失败一律回 `{ ok: false, message }`，消息直接给大模型读，要写明怎么改：可选的模型、合法的取值。
 * 用户停止时 signal 中止，异常原样抛出，由工具波次按中断收尾。
 */

import type { MediaCall, MediaCallResult, MediaPort } from '@qywork/agent'
import {
  buildMediaAdapter,
  lookupMediaModel,
  MediaError,
  type MediaInput,
  type MediaModelSpec,
  type MediaOperation,
  type MediaUsage,
  mediaCost,
  operationLabel,
  validateMediaCall,
} from '@qywork/ai'
import type { MediaKind, MediaOutput, MediaSpend } from '@qywork/core'
import { listMediaModels, type QyConfig, resolveMediaModel } from './config.ts'

const OUTPUT_LABEL: Record<MediaOutput, string> = { image: '图像', video: '视频', audio: '音频' }

/**
 * 由输入推操作。不让大模型选操作：少一个它会填错的枚举，也不会出现「选了图生却没给图」。
 * 输入组合本身不成立时回 `problem`，直接退回。
 */
export function operationOf(
  type: MediaOutput,
  inputs: MediaInput[],
): { operation: MediaOperation } | { problem: string } {
  const count = (role: MediaInput['role']) => inputs.filter((i) => i.role === role).length
  if (type === 'image') return { operation: inputs.length > 0 ? 'edit' : 'generate' }
  if (type === 'audio') {
    return inputs.length ? { problem: '语音合成不收输入文件' } : { operation: 'speech' }
  }
  const first = count('first_frame')
  const last = count('last_frame')
  const references = count('reference')
  const videos = count('video')
  if (first > 1 || last > 1) return { problem: '首帧、尾帧各只能给一张' }
  if (last && !first) return { problem: '给了尾帧就要给首帧' }
  // 各家都把首尾帧与参考素材列为互斥的两类任务。
  if (first && (references || videos)) return { problem: '首尾帧不能与参考图、参考视频同时给' }
  if (videos) return { operation: 'video_to_video' }
  if (first && last) return { operation: 'first_last_frame' }
  if (first) return { operation: 'image_to_video' }
  if (references) return { operation: 'reference_to_video' }
  return { operation: 'text_to_video' }
}

/**
 * 一次成功生成的花费。数量按类别取接口回报的张数、秒数或字符数，金额见 `mediaCost`。
 * 只在成功时产生：失败的请求各家都不计费。
 */
function spendOf(
  spec: MediaModelSpec,
  usage: MediaUsage,
  output: MediaOutput,
  target: { kind: MediaKind; provider: string; model: string },
): MediaSpend {
  const { cost, currency } = mediaCost(spec, usage)
  const quantity =
    output === 'image' ? usage.images : output === 'video' ? usage.seconds : usage.characters
  return {
    kind: target.kind,
    provider: target.provider,
    model: target.model,
    output,
    quantity: quantity ?? null,
    cost,
    currency,
    at: Date.now(),
  }
}

/** `onSpend`：每次成功生成交出花费，由会话层记进所属轮次。 */
export function makeMediaPort(config: QyConfig, onSpend?: (spend: MediaSpend) => void): MediaPort {
  return {
    async generate(call: MediaCall, signal: AbortSignal): Promise<MediaCallResult> {
      const label = OUTPUT_LABEL[call.type]
      const candidates = listMediaModels(config).filter((m) => m.output === call.type)
      const choices = candidates.map((m) => `${m.provider} / ${m.model}`).join('、') || '（无）'
      const ref =
        call.provider !== undefined && call.model !== undefined
          ? { provider: call.provider, model: call.model }
          : undefined
      const target = resolveMediaModel(config, call.type, ref)
      if (!target) {
        return {
          ok: false,
          message: ref
            ? `没有这个${label}模型：${ref.provider} / ${ref.model}。可选：${choices}`
            : `没有默认的${label}模型，用 provider 与 model 指定一个。可选：${choices}`,
        }
      }
      if (!target.apiKey) {
        return {
          ok: false,
          message: `接口 ${target.provider} 没有配置 API Key，在设置 → 模型里填写`,
        }
      }

      const inferred = operationOf(call.type, call.inputs)
      if ('problem' in inferred) return { ok: false, message: `没有发出请求：${inferred.problem}` }
      const op = inferred.operation
      // 接续取回不再提交，参数与输入都不会发出，不校验。
      if (!call.resumeTaskId) {
        const spec = lookupMediaModel(target.model, target.kind)
        const problems = validateMediaCall(spec, op, call.params, {
          images: call.inputs.filter((i) => i.role === 'reference').length,
          videos: call.inputs.filter((i) => i.role === 'video').length,
        })
        if (problems.length > 0) {
          const others = candidates
            .filter((m) => m.provider !== target.provider || m.model !== target.model)
            .filter((m) => lookupMediaModel(m.model, m.kind).operations.includes(op))
            .map((m) => `${m.provider} / ${m.model}`)
          return {
            ok: false,
            message:
              `没有发出请求：\n- ${problems.join('\n- ')}` +
              (others.length && !spec.operations.includes(op)
                ? `\n支持${operationLabel(op)}的其他模型：${others.join('、')}`
                : ''),
          }
        }
      }

      const adapter = buildMediaAdapter({
        kind: target.kind,
        model: target.model,
        apiKey: target.apiKey,
        ...(target.baseUrl ? { baseUrl: target.baseUrl } : {}),
        ...(target.headers ? { headers: target.headers } : {}),
      })
      try {
        const result = await adapter.run(
          {
            operation: op,
            prompt: call.prompt,
            inputs: call.inputs,
            params: call.params,
          },
          {
            signal,
            ...(call.onTask
              ? {
                  onTask: (taskId: string) =>
                    call.onTask?.({ taskId, provider: target.provider, model: target.model }),
                }
              : {}),
            ...(call.onStatus ? { onStatus: call.onStatus } : {}),
            ...(call.resumeTaskId ? { resumeTaskId: call.resumeTaskId } : {}),
          },
        )
        onSpend?.(spendOf(adapter.spec, result.usage ?? {}, call.type, target))
        return { ok: true, provider: target.provider, model: target.model, files: result.files }
      } catch (err) {
        if (signal.aborted || !(err instanceof MediaError)) throw err
        return {
          ok: false,
          message: `${target.provider} / ${target.model}：${err.message}`,
          ...(err.pendingTaskId ? { pendingTaskId: err.pendingTaskId } : {}),
        }
      }
    },
  }
}
