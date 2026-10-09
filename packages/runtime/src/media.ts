/**
 * 生成端口的实现：选择模型、由输入推断操作、按目录校验参数、调用生成接口。读取输入与写入产物由工具负责（`tools/generate.ts`）。
 * `art` 类别交给 `art.ts`，由对话模型写出 HTML 页面。
 *
 * 失败一律返回 `{ ok: false, message }`，消息直接交给大模型阅读，须写明修改方法：可选的模型、合法的取值。
 * 用户停止时 signal 中止，异常原样抛出，由工具波次按中断处理收尾。
 */

import type { MediaCall, MediaCallResult, MediaPort } from '@qywork/agent'
import {
  buildMediaAdapter,
  lookupMediaModel,
  type MediaCancel,
  MediaError,
  type MediaImageResult,
  type MediaInput,
  type MediaModelSpec,
  type MediaOperation,
  type MediaUsage,
  mediaCost,
  operationLabel,
  validateMediaCall,
} from '@qywork/ai'
import { type MediaKind, type MediaOutput, type MediaSpend, mediaOperationFor } from '@qywork/core'
import { generateArt } from './art.ts'
import { listMediaModels, type QyConfig, resolveMediaModel } from './config.ts'

const OUTPUT_LABEL: Record<MediaOutput, string> = { image: '图像', video: '视频', audio: '音频' }

/**
 * 由输入推断操作。操作不由大模型选择：可减少一个易填错的枚举参数，也避免出现选择了图生视频却未提供图片的情况。
 * 输入组合本身无效时返回 `problem`，直接拒绝。
 */
export function operationOf(
  type: MediaOutput,
  inputs: MediaInput[],
): { operation: MediaOperation } | { problem: string } {
  const count = (role: MediaInput['role']) => inputs.filter((i) => i.role === role).length
  if (type === 'audio') {
    return inputs.length ? { problem: '语音合成不接受输入文件' } : { operation: 'speech' }
  }
  const first = count('first_frame')
  const last = count('last_frame')
  if (first > 1 || last > 1) return { problem: '首帧、尾帧各只能提供一张' }
  return {
    operation: mediaOperationFor(
      type,
      inputs.map((i) => i.role),
    ),
  }
}

/**
 * 一次成功生成的花费。数量按类别取接口返回的张数、秒数或字符数，金额由 `mediaCost` 计算。
 * 图片在服务商返回产物时计量，下载是否成功不改变该次计量。
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

/** `onSpend`：服务商返回生成结果时传出花费，由调用方记入账本。 */
export function makeMediaPort(config: QyConfig, onSpend?: (spend: MediaSpend) => void): MediaPort {
  // 端口按一轮执行创建；结果未知或待下载时，本轮只允许恢复，不再自动提交图片生成。
  let unresolvedImage = false
  return {
    async generate(call: MediaCall, signal: AbortSignal): Promise<MediaCallResult> {
      // art 使用对话模型，不经生成目录。
      if (call.type === 'art') return generateArt(config, call, signal, onSpend)
      if (call.type === 'image' && unresolvedImage && !call.resumeImageResult) {
        return {
          ok: false,
          executed: false,
          message:
            '本轮图片结果尚未确认，已停止自动重新生成；已有任务记录时请取回原结果。重新生成须由用户明确发起。',
        }
      }
      const type = call.type
      const label = OUTPUT_LABEL[type]
      const candidates = listMediaModels(config).filter((m) => m.output === type)
      const choices = candidates.map((m) => `${m.provider} / ${m.model}`).join('、') || '（无）'
      const ref =
        call.provider !== undefined && call.model !== undefined
          ? { provider: call.provider, model: call.model }
          : undefined
      const target = resolveMediaModel(config, type, ref)
      if (!target) {
        return {
          ok: false,
          executed: false,
          message: ref
            ? `未找到该${label}模型：${ref.provider} / ${ref.model}。可选：${choices}`
            : `没有默认的${label}模型，请通过 provider 与 model 指定。可选：${choices}`,
        }
      }
      if (!target.apiKey) {
        return {
          ok: false,
          executed: false,
          message: `接口 ${target.provider} 未配置 API Key，请在设置 → 模型中填写`,
        }
      }

      const inferred = operationOf(type, call.inputs)
      if ('problem' in inferred)
        return { ok: false, executed: false, message: `未发出请求：${inferred.problem}` }
      const op = inferred.operation
      // 接续取回不会重新提交，参数与输入均不发出，因此不校验。
      if (!call.resumeTaskId && !call.resumeImageResult) {
        const spec = lookupMediaModel(target.model, target.kind)
        const problems = validateMediaCall(spec, op, call.params, {
          images: call.inputs.filter((i) => i.role === 'reference').length,
          videos: call.inputs.filter((i) => i.role === 'video').length,
          audios: call.inputs.filter((i) => i.role === 'audio').length,
          firstFrames: call.inputs.filter((i) => i.role === 'first_frame').length,
          lastFrames: call.inputs.filter((i) => i.role === 'last_frame').length,
        })
        if (problems.length > 0) {
          const others = candidates
            .filter((m) => m.provider !== target.provider || m.model !== target.model)
            .filter((m) => lookupMediaModel(m.model, m.kind).operations.includes(op))
            .map((m) => `${m.provider} / ${m.model}`)
          return {
            ok: false,
            executed: false,
            message:
              `未发出请求：\n- ${problems.join('\n- ')}` +
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
      let receivedImage = false
      let spendReported = false
      const reportSpend = (usage: MediaUsage) => {
        if (spendReported || call.resumeImageResult) return
        spendReported = true
        const spend = spendOf(adapter.spec, usage, type, target)
        onSpend?.(spend)
        call.onSpend?.(spend)
      }
      try {
        if (call.resumeImageResult) {
          if (!adapter.resumeImage)
            return { ok: false, executed: false, message: '该协议不支持取回图片结果' }
          const result = await adapter.resumeImage(call.resumeImageResult, { signal })
          return { ok: true, provider: target.provider, model: target.model, ...result }
        }
        const result = await adapter.run(
          {
            operation: op,
            prompt: call.prompt,
            inputs: call.inputs,
            params: call.params,
          },
          {
            signal,
            ...(type === 'image'
              ? {
                  onImageResult: async (result: MediaImageResult) => {
                    receivedImage = true
                    reportSpend(result.usage ?? {})
                    await call.onImageResult?.(result, target.provider, target.model)
                  },
                }
              : {}),
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
        reportSpend(result.usage ?? {})
        return {
          ok: true,
          provider: target.provider,
          model: target.model,
          files: result.files,
          ...(result.warning ? { warning: result.warning } : {}),
        }
      } catch (err) {
        if (
          type === 'image' &&
          (receivedImage ||
            call.resumeImageResult ||
            !(err instanceof MediaError) ||
            err.diagnostic?.outcome !== 'rejected')
        )
          unresolvedImage = true
        if (signal.aborted || !(err instanceof MediaError)) throw err
        return {
          ok: false,
          message: `${target.provider} / ${target.model}：${err.message}`,
          ...(err.pendingTaskId ? { pendingTaskId: err.pendingTaskId } : {}),
          ...(receivedImage || call.resumeImageResult ? { recoverable: true } : {}),
          ...(err.diagnostic ? { diagnostic: err.diagnostic } : {}),
        }
      }
    },
  }
}

/**
 * 撤销已提交的视频任务。`unsupported`：该接口不支持撤销，任务无法撤回，按结果计费。
 * 模型已从配置中删除或没有密钥时抛错：此时无法确定能否撤销，不能视为无法撤回。
 */
export async function cancelMediaTask(
  config: QyConfig,
  task: { provider: string; model: string; taskId: string },
  signal: AbortSignal,
): Promise<MediaCancel | 'unsupported'> {
  const target = resolveMediaModel(config, 'video', { provider: task.provider, model: task.model })
  if (!target?.apiKey) {
    throw new MediaError(
      `接口 ${task.provider} / ${task.model} 不在配置中或未配置 API Key，未执行撤销`,
    )
  }
  const adapter = buildMediaAdapter({
    kind: target.kind,
    model: target.model,
    apiKey: target.apiKey,
    ...(target.baseUrl ? { baseUrl: target.baseUrl } : {}),
    ...(target.headers ? { headers: target.headers } : {}),
  })
  return adapter.cancel ? adapter.cancel(task.taskId, signal) : 'unsupported'
}
