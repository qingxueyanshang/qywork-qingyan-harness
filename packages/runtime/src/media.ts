/**
 * 生成端口的实现：选择模型、由输入推断操作、按目录校验参数、调用生成接口。读取输入与写入产物由工具负责（`tools/generate.ts`）。
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
  type MediaInput,
  type MediaModelSpec,
  type MediaOperation,
  type MediaUsage,
  mediaCost,
  operationLabel,
  validateMediaCall,
} from '@qywork/ai'
import { type MediaKind, type MediaOutput, type MediaSpend, mediaOperationFor } from '@qywork/core'
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
 * 只在成功时产生：各厂商对失败的请求均不计费。
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

/** `onSpend`：每次成功生成时传出花费，由会话层记入所属轮次。 */
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
            ? `未找到该${label}模型：${ref.provider} / ${ref.model}。可选：${choices}`
            : `没有默认的${label}模型，请通过 provider 与 model 指定。可选：${choices}`,
        }
      }
      if (!target.apiKey) {
        return {
          ok: false,
          message: `接口 ${target.provider} 未配置 API Key，请在设置 → 模型中填写`,
        }
      }

      const inferred = operationOf(call.type, call.inputs)
      if ('problem' in inferred) return { ok: false, message: `未发出请求：${inferred.problem}` }
      const op = inferred.operation
      // 接续取回不会重新提交，参数与输入均不发出，因此不校验。
      if (!call.resumeTaskId) {
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
        const spend = spendOf(adapter.spec, result.usage ?? {}, call.type, target)
        onSpend?.(spend)
        call.onSpend?.(spend)
        return {
          ok: true,
          provider: target.provider,
          model: target.model,
          files: result.files,
          ...(result.warning ? { warning: result.warning } : {}),
        }
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
