/**
 * 使用对话模型的生成类别（`art`、`text`）共用的一次请求：选定卡片的对话模型，不带工具发送一条用户消息，
 * 取得回复全文后交给该类别转为产物。各类别只提供系统提示词、用户消息与回复的取用方式（`ChatGeneration`）。
 *
 * 被限流或暂时故障、尚未收到正文时按对话请求的重发规则重试。失败的约定与生成端口相同：返回 `{ ok: false, message }`；
 * 用户停止时 signal 中止，异常原样抛出。
 */

import {
  concurrencyRejected,
  type SendOutcome,
  sendLane,
  sendLimiter,
  transientErrorCode,
} from '@qywork/agent'
import {
  buildAdapter,
  type ChatRequest,
  type ContentBlock,
  computeCost,
  isLocalEndpoint,
  type MediaFile,
  type MediaInput,
  ProviderError,
  type ProviderUsage,
  STREAM_IDLE_TIMEOUT_MS,
} from '@qywork/ai'
import {
  CHAT_MENTION,
  type ChatOutput,
  log,
  type MediaSpend,
  modelMention,
  RESEND_LIMIT,
  resendDelay,
  waitOrAbort,
} from '@qywork/core'
import type { MediaCall, MediaCallResult } from '@qywork/tools'
import {
  type ModelRef,
  type QyConfig,
  type ResolvedModel,
  resolveModel,
  savedDisplayName,
} from '../config.ts'

/** 回复转为产物的结果。`ok: false` 的 `message` 不含模型名称，由调用方在前面加上。 */
export type ChatReply =
  | { ok: true; file: MediaFile; warning?: string }
  | { ok: false; message: string }

/** 一个类别的请求内容与回复的取用方式。 */
export interface ChatGeneration {
  system: string
  content: ContentBlock[]
  /** 回复全文转为产物；`truncated` 为真表示输出达到上限，回复不完整。 */
  reply(text: string, truncated: boolean): ChatReply
}

/** 第 n 张参考图在要求中的名称（`CHAT_MENTION`），n 从 1 开始。 */
export const imageMention = (n: number) => CHAT_MENTION.image.replaceAll('{n}', String(n))

/** 参考图的内容块。 */
export function imageBlock(input: MediaInput): ContentBlock {
  return {
    type: 'image',
    mimeType: input.mime,
    source: { kind: 'base64', data: Buffer.from(input.bytes).toString('base64') },
  }
}

/**
 * 卡片使用的对话模型：卡片指定的接口与模型，未指定时为默认对话模型；须配置在该接口下。
 * 生成与画布的参数表共用，与生成模型相同：未配置的模型在画布更新时即被拒绝。
 *
 * 不要改用 `resolveModel`：它对写明接口的引用不要求模型配置在该接口下（会话可使用接口下未列出的型号），
 * 卡片改换到未配置的模型时，请求会以该接口的地址与 key 发出。已下架的型号照常返回，由生成时拒绝。
 */
export function resolveChatModel(
  config: QyConfig,
  ref: ModelRef | undefined,
): ResolvedModel | undefined {
  const target = ref ?? config.active
  if (!target || !config.providers[target.provider]?.models[target.model]) return undefined
  return resolveModel(config, target)
}

export async function runChatGeneration(
  config: QyConfig,
  output: ChatOutput,
  call: MediaCall,
  generation: ChatGeneration,
  signal: AbortSignal,
  onSpend?: (spend: MediaSpend) => void,
): Promise<MediaCallResult> {
  const ref =
    call.provider !== undefined && call.model !== undefined
      ? { provider: call.provider, model: call.model }
      : undefined
  /** 消息中提及模型的写法，与生成模型的消息相同（`modelMention`）。 */
  const named = (r: ModelRef) => modelMention(r, savedDisplayName(config, output, r))
  const choices =
    Object.entries(config.providers)
      .flatMap(([name, p]) =>
        Object.entries(p.models)
          .filter(([, m]) => !m.delisted)
          .map(([m]) => named({ provider: name, model: m })),
      )
      .join('、') || '（无）'
  const target = resolveChatModel(config, ref)
  if (!target) {
    return {
      ok: false,
      message: ref
        ? `未找到该对话模型：${named(ref)}。可选：${choices}`
        : `没有默认的对话模型，请通过 provider 与 model 指定。可选：${choices}`,
    }
  }
  // 渠道已不再提供该型号，请求必然被拒绝；与生成模型的处理相同。
  if (target.delisted) {
    return { ok: false, message: `${named(target)} 已下架，未发出请求。可选：${choices}` }
  }
  // 本机地址不要求 key，与对话请求相同（`isLocalEndpoint`）。
  if (!target.apiKey && !isLocalEndpoint(target.baseUrl)) {
    return { ok: false, message: `接口 ${target.provider} 未配置 API Key，请在设置 → 模型中填写` }
  }
  const adapter = buildAdapter({
    kind: target.kind,
    apiKey: target.apiKey ?? '',
    model: target.model,
    ...(target.baseUrl ? { baseUrl: target.baseUrl } : {}),
    ...(target.headers ? { headers: target.headers } : {}),
    ...(target.spec ? { spec: target.spec } : {}),
    ...(target.transport ? { transport: target.transport } : {}),
  })
  const req: ChatRequest = {
    model: adapter.spec.id,
    system: [{ text: generation.system }],
    messages: [{ role: 'user', content: generation.content }],
    tools: [],
    maxOutputTokens: adapter.spec.maxOutputTokens,
    idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    signal,
  }

  const label = named(target)
  let text = ''
  let usage: ProviderUsage | null = null
  let truncated = false
  for (let resends = 0; ; resends++) {
    let failed: ProviderError | null = null
    // 与对话请求取得同一个在途名额：第三方接口的并发按请求方计算（`sendLimiter`）。
    let release: ((outcome: SendOutcome) => void) | null = null
    try {
      const granted = await sendLimiter.acquire(sendLane(adapter), signal)
      release = granted
      for await (const ev of adapter.stream(req)) {
        if (ev.type === 'text_delta') text += ev.delta
        else if (ev.type === 'usage') usage = ev.usage
        else if (ev.type === 'done') truncated = ev.stopReason === 'max_tokens'
      }
      granted('completed')
    } catch (err) {
      release?.(concurrencyRejected(err) ? 'concurrency_rejected' : 'failed')
      if (signal.aborted || !(err instanceof ProviderError)) throw err
      failed = err
    } finally {
      // 对话接口按 token 计费，回复不完整同样计费：收到用量即记账。收到用量的请求不重发，用量只记一次。
      if (usage) {
        const spend: MediaSpend = {
          kind: adapter.kind,
          provider: target.provider,
          model: target.model,
          output,
          quantity: usage.outputTokens,
          cost: computeCost(adapter.spec, usage),
          currency: adapter.spec.pricing.currency ?? 'USD',
          at: Date.now(),
        }
        onSpend?.(spend)
        call.onSpend?.(spend)
      }
    }
    if (!failed) break
    /*
     * 与对话请求的重发同一判定（`transientErrorCode`）与同一套次数、间隔（`RESEND_LIMIT`、`resendDelay`），
     * 重试经 `call.onRetry` 回报，卡片显示与其他类别相同。只重发尚未收到正文与用量的请求：已收到部分回复时重发即重新生成全文，
     * 按失败返回；收到用量（用量事件或随失败附带的 `usage`）的请求已计费。
     */
    if (
      text ||
      usage ||
      failed.usage ||
      !transientErrorCode(failed.code) ||
      resends >= RESEND_LIMIT
    ) {
      const receipt = resends ? `；已自动重试 ${resends} 次，仍失败` : ''
      return { ok: false, message: `${label}：${failed.message}${receipt}` }
    }
    const wait = resendDelay(resends, failed.retryAfterMs)
    // 每次重试写一行，写法与对话请求的重发日志相同；`call.logFields` 对应到发起的画布卡片或工具调用。
    log.warn(output, `请求失败：${failed.message}`, {
      retry: resends + 1,
      code: failed.code,
      waitSeconds: Math.round(wait / 1000),
      ...call.logFields,
    })
    call.onRetry?.({ attempt: resends + 1, max: RESEND_LIMIT, reason: failed.message })
    // 等待被中止时不回报结束：请求没有重新发出。
    await waitOrAbort(wait, signal)
    call.onRetry?.(null)
  }

  const reply = generation.reply(text, truncated)
  if (!reply.ok) return { ok: false, message: `${label}：${reply.message}` }
  return {
    ok: true,
    provider: target.provider,
    model: target.model,
    files: [reply.file],
    ...(reply.warning ? { warning: reply.warning } : {}),
  }
}
