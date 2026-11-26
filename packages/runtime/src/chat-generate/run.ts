/**
 * 使用对话模型的生成类别（`art`、`text`）共用的一次请求：选定卡片的对话模型，不带工具发送一条用户消息，
 * 取得回复全文后交给该类别转为产物。各类别只提供系统提示词、用户消息与回复的取用方式（`ChatGeneration`）。
 * 参考视频的发送方式在此统一决定（`videoBlocks`），各类别只决定它们在消息中的位置。
 *
 * 被限流或暂时故障、尚未收到正文时按对话请求的重发规则重试。失败的约定与生成端口相同：返回 `{ ok: false, message }`；
 * 用户停止时 signal 中止，异常原样抛出。
 */

import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { basename } from 'node:path'
import {
  concurrencyRejected,
  materialize,
  mediaCapabilitiesOf,
  runDensity,
  type SendOutcome,
  sendLane,
  sendLimiter,
  transientErrorCode,
  videoDelivery,
  videoMetaOf,
} from '@qywork/agent'
import {
  buildAdapter,
  type ChatRequest,
  type ContentBlock,
  computeCost,
  isLocalEndpoint,
  type LlmAdapter,
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
import {
  type MediaCall,
  type MediaCallResult,
  type OfficePort,
  officeRunDir,
  sampleVideoFrames,
} from '@qywork/tools'
import {
  collectSecrets,
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
  /** 用户消息。`video(input)` 是该参考视频的内容块（`videoBlocks`），由调用方按发送方式准备。 */
  content(video: (input: MediaInput) => ContentBlock[]): ContentBlock[]
  /** 回复全文转为产物；`truncated` 为真表示输出达到上限，回复不完整。 */
  reply(text: string, truncated: boolean): ChatReply
}

/**
 * 装配方提供的依赖。`office` 用于模型不接受原生视频时抽帧（Office 的 Python worker）；没有时这类视频无法发送，该次生成失败。
 */
export interface ChatDeps {
  onSpend?: (spend: MediaSpend) => void
  office?: OfficePort
}

/** 第 n 张参考图在要求中的名称（`CHAT_MENTION`），n 从 1 开始。 */
export const imageMention = (n: number) => CHAT_MENTION.image.replaceAll('{n}', String(n))

/** 第 n 段参考视频在要求中的名称（`CHAT_MENTION`），n 从 1 开始。 */
export const videoMention = (n: number) => CHAT_MENTION.video.replaceAll('{n}', String(n))

/** 抽帧时 worker 的临时目录归属（`officeRunDir` 的会话段）：生成请求不属于任何会话，抽帧结束后整个目录删除。 */
const FRAMES_SCOPE = 'media-frames'

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

/**
 * 一段参考视频的内容块。发送方式与会话读取视频的判定相同（`videoDelivery`）：在模型的原生范围内时为视频块，
 * 发送前由 `materialize` 内联或由适配器上传；否则经 Office worker 按画面变化抽帧，帧作为图片发送。
 * 两种方式都先写明名称、时长与画面尺寸。无法发送时返回原因。
 */
async function videoBlocks(
  config: QyConfig,
  adapter: LlmAdapter,
  call: MediaCall,
  input: MediaInput,
  n: number,
  office: OfficePort | undefined,
  signal: AbortSignal,
): Promise<ContentBlock[] | string> {
  const name = videoMention(n)
  const meta = videoMetaOf(input.path) ?? {
    bytes: input.bytes.byteLength,
    seconds: null,
    size: null,
    audio: false,
  }
  const facts = [
    meta.seconds === null ? '时长未知' : `时长 ${Number(meta.seconds.toFixed(1))} 秒`,
    meta.size ? `${meta.size.width}×${meta.size.height}` : '尺寸未知',
  ].join('，')
  const delivery = videoDelivery(
    meta,
    runDensity(adapter).video,
    adapter.transmits.mediaUploadAbove,
  )
  if (delivery !== 'frames') {
    return [
      { type: 'text', text: `${name}（${facts}）：` },
      { type: 'video', mimeType: input.mime, source: { kind: 'path', path: input.path }, meta },
    ]
  }
  const file = basename(input.path)
  if (adapter.spec.vision === false) return `${name}（${file}）：当前模型既不接受视频也不接受图片`
  if (!office || !call.workspaceRoot) {
    return `${name}（${file}）：当前模型不接受该视频，按画面抽帧需要 Office 的 Python 运行环境，当前没有可用的环境`
  }
  const runId = randomUUID()
  const scope = {
    workspaceRoot: call.workspaceRoot,
    conversationId: FRAMES_SCOPE,
    runId,
    signal,
    secrets: collectSecrets(config),
  }
  try {
    const sampled = await sampleVideoFrames(scope, office, input.path)
    if (!sampled.ok) return `${name}（${file}）：抽帧失败：${sampled.message}`
    return [
      {
        type: 'text',
        text: `${name}（${facts}）：按画面变化抽取的 ${sampled.frames.length} 帧，依次如下。`,
      },
      ...sampled.frames.flatMap((f): ContentBlock[] => [
        { type: 'text', text: `${name} ${f.label}：` },
        {
          type: 'image',
          mimeType: f.mime,
          source: { kind: 'base64', data: Buffer.from(f.bytes).toString('base64') },
        },
      ]),
    ]
  } finally {
    await rm(officeRunDir(call.workspaceRoot, FRAMES_SCOPE, runId), {
      recursive: true,
      force: true,
    }).catch(() => {})
  }
}

export async function runChatGeneration(
  config: QyConfig,
  output: ChatOutput,
  call: MediaCall,
  generation: ChatGeneration,
  signal: AbortSignal,
  deps: ChatDeps,
): Promise<MediaCallResult> {
  const { onSpend } = deps
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
  const videos = new Map<MediaInput, ContentBlock[]>()
  for (const input of call.inputs) {
    if (input.role !== 'video') continue
    const blocks = await videoBlocks(
      config,
      adapter,
      call,
      input,
      videos.size + 1,
      deps.office,
      signal,
    )
    if (typeof blocks === 'string') return { ok: false, message: blocks }
    videos.set(input, blocks)
  }
  // 原生发送的视频以路径给出，`materialize` 按适配器读取字节或保留路径交给适配器上传，与会话的请求相同。
  const density = runDensity(adapter)
  const req: ChatRequest = await materialize(
    {
      model: adapter.spec.id,
      system: [{ text: generation.system }],
      messages: [{ role: 'user', content: generation.content((input) => videos.get(input) ?? []) }],
      tools: [],
      maxOutputTokens: adapter.spec.maxOutputTokens,
      idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
      signal,
    },
    mediaCapabilitiesOf(adapter, { density, imagesRejected: false, videosRejected: false }),
    null,
  )

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
