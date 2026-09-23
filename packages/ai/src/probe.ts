/** 已声明模型按库中档位校验，未声明模型尝试五档。仅由用户显式触发。 */
import {
  EFFORT_ORDER,
  type EffortLevel,
  type ProviderKind,
  type ThinkingMode,
  type ToolCallCheck,
} from '@qywork/core'
import { declaredEffortLevels, effortIsTransmittable, lookupModel } from './catalog.ts'
import { ProviderError } from './errors.ts'
import { buildAdapter } from './factory.ts'
import { probeToolCalls } from './probe-tools.ts'
import { STREAM_IDLE_TIMEOUT_MS } from './transport.ts'
import {
  type ChatRequest,
  hasThinkingEvidence,
  type ProviderProfile,
  type TransportCapabilities,
} from './types.ts'

const LEVELS = EFFORT_ORDER.filter((level) => level !== 'minimal')
const INVALID_EFFORT = '__qy_probe_invalid_effort__'

export interface ProbeOutcome {
  toolCalls?: ToolCallCheck
  reachable: boolean
  untested: 'effort'[]
  /** 超时、限速或非法值也被接受时，不能据此改写配置。 */
  inconclusive: 'effort'[]
  /** catalog = 模型库声明的档位；probe = 接口接受的候选值，独立强度未确认。 */
  effortSource: 'catalog' | 'probe'
  effortLevels: EffortLevel[]
  /** 本次实际发送参数所用的格式。仅在探测有明确结论时写回。 */
  thinking?: ThinkingMode
  /** 汇总正常请求的思考证据，不推断未观察到的能力。 */
  thinkingObserved: boolean
  probes: ProbeStep[]
}

export interface ProbeStep {
  name: string
  ok: boolean
  detail: string
  skipped?: boolean
  inconclusive?: boolean
}

type Verdict = 'accepted' | 'rejected' | 'inconclusive'

async function attempt(
  profile: ProviderProfile,
  name: string,
  level: string | undefined,
  signal?: AbortSignal,
): Promise<{ step: ProbeStep; thought: boolean; verdict: Verdict; effortRejected?: boolean }> {
  let thought = false
  try {
    // 探针必须把候选值真正发出去；运行时的目录白名单不能提前过滤它。
    // 非法值只在这次局部请求中越过类型约束，永不进入探测档位或持久化结果。
    const effort = level as EffortLevel | undefined
    const adapter = buildAdapter(
      level === undefined
        ? {
            ...profile,
            spec: {
              ...profile.spec,
              thinking: 'none',
              effortLevels: [],
              chatReasoningProtocol: 'standard',
            },
          }
        : {
            ...profile,
            spec: { ...profile.spec, effortLevels: [effort!] },
          },
    )
    const request: ChatRequest = {
      model: profile.model,
      system: [],
      messages: [
        {
          role: 'user',
          content: '求满足 n 除以 7 余 3、除以 11 余 5、除以 13 余 7 的最小正整数 n。只输出答案。',
        },
      ],
      tools: [],
      maxOutputTokens: 2048,
      idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
      ...(effort ? { effort } : {}),
      ...(signal ? { signal } : {}),
    }
    for await (const ev of adapter.stream(request)) {
      thought ||= hasThinkingEvidence(ev)
      if (ev.type === 'done') break
    }
    return { step: { name, ok: true, detail: '接受' }, thought, verdict: 'accepted' }
  } catch (err) {
    const rejected = err instanceof ProviderError && err.code === 'invalid_request'
    return {
      step: {
        name,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
        ...(rejected ? {} : { inconclusive: true }),
      },
      thought,
      verdict: rejected ? 'rejected' : 'inconclusive',
      effortRejected:
        rejected &&
        /effort|思考档位|推理强度/i.test(err.message) &&
        !/max_tokens|max_output_tokens|max_completion_tokens|budget_tokens/i.test(err.message),
    }
  }
}

export interface ProbeOptions {
  signal?: AbortSignal
  gapMs?: number
}

export async function probeModel(
  profile: ProviderProfile,
  opts: ProbeOptions = {},
): Promise<ProbeOutcome> {
  const outcome = await probeEffort(profile, opts)
  if (outcome.reachable && !opts.signal?.aborted) {
    const { transport: _previous, ...declared } = profile
    const result = await probeToolCalls(declared, opts.signal)
    outcome.toolCalls = result.check
    outcome.thinkingObserved ||= result.thinkingObserved
    outcome.probes.push(...result.steps)
  }
  return outcome
}

async function probeEffort(
  profile: ProviderProfile,
  opts: ProbeOptions = {},
): Promise<ProbeOutcome> {
  // 保留用户的参数格式声明，移除上次检测结果，允许重新发现已恢复的档位。
  const { transport: _previous, ...declared } = profile
  const seed = lookupModel(profile.model, profile.kind)
  const levels = declaredEffortLevels(seed, profile.spec)
  const bare = await attempt(declared, '最小请求', undefined, opts.signal)
  const outcome: ProbeOutcome = {
    reachable: bare.step.ok,
    untested: [],
    inconclusive: [],
    effortSource: levels === undefined ? 'probe' : 'catalog',
    effortLevels: [],
    thinkingObserved: bare.thought,
    probes: [bare.step],
  }
  if (!bare.step.ok) return outcome

  const spec = buildAdapter(declared).spec
  if (levels?.length === 0) {
    outcome.probes.push({
      name: '思考档位',
      ok: true,
      skipped: true,
      detail: '模型库未声明 effort 档位',
    })
    return outcome
  }
  // 有声明时只校验声明；未知格式仅在已有适配器支持的写法中检测。
  const modes: ThinkingMode[] =
    seed.catalogued !== false || declared.spec?.thinking !== undefined
      ? [spec.thinking]
      : declared.kind === 'anthropic_messages'
        ? ['adaptive_only', 'none']
        : declared.kind === 'openai_chat_completions'
          ? ['reasoning_effort', 'deepseek_thinking']
          : ['reasoning_effort']
  const candidates = modes.filter((thinking) =>
    effortIsTransmittable({ ...spec, thinking, effortLevels: levels ?? LEVELS }),
  )
  if (candidates.length === 0) {
    outcome.untested = ['effort']
    outcome.probes.push({
      name: '思考档位',
      ok: false,
      skipped: true,
      detail: '模型库声明的思考参数格式无法通过当前协议发送',
    })
    return outcome
  }
  let selected: ProbeOutcome | undefined
  let unconfirmedFormat = false
  for (const thinking of candidates) {
    const probing: ProviderProfile = { ...declared, spec: { ...declared.spec, thinking } }
    const { result, interrupted } = await probeFormat(
      probing,
      levels ?? LEVELS,
      outcome.effortSource,
      opts,
    )
    outcome.thinkingObserved ||= result.thinkingObserved
    unconfirmedFormat ||= result.inconclusive.length > 0
    outcome.probes.push(
      ...result.probes.map((step) => ({
        ...step,
        name: candidates.length > 1 ? `${thinking} / ${step.name}` : step.name,
      })),
    )
    if (
      !selected ||
      (!result.inconclusive.length &&
        (selected.inconclusive.length ||
          (result.effortLevels.length > 0 && selected.effortLevels.length === 0) ||
          (result.effortLevels.length > 0 &&
            result.thinkingObserved &&
            !selected.thinkingObserved)))
    )
      selected = result
    // 临时错误不作为更换参数格式的依据；完整正向证据无需继续试其他格式。
    if (interrupted) {
      selected.inconclusive = ['effort']
      break
    }
    if (!result.inconclusive.length && result.effortLevels.length && result.thinkingObserved) break
  }
  outcome.effortLevels = selected!.effortLevels
  outcome.inconclusive =
    !selected!.effortLevels.length && unconfirmedFormat ? ['effort'] : selected!.inconclusive
  outcome.thinking = selected!.thinking!
  return outcome
}

async function probeFormat(
  profile: ProviderProfile,
  levels: EffortLevel[],
  effortSource: ProbeOutcome['effortSource'],
  opts: ProbeOptions,
): Promise<{ result: ProbeOutcome; interrupted: boolean }> {
  const result: ProbeOutcome = {
    reachable: true,
    untested: [],
    inconclusive: [],
    effortSource,
    effortLevels: [],
    thinking: profile.spec!.thinking!,
    thinkingObserved: false,
    probes: [],
  }
  let interrupted = false
  let rejectedEffort = 0
  const pause = () => new Promise((resolve) => setTimeout(resolve, opts.gapMs ?? 300))
  for (const level of levels) {
    if (opts.signal?.aborted) {
      interrupted = true
      break
    }
    await pause()
    const checked = await attempt(profile, `effort=${level}`, level, opts.signal)
    result.probes.push(checked.step)
    result.thinkingObserved ||= checked.thought
    if (checked.verdict === 'accepted') result.effortLevels.push(level)
    if (checked.effortRejected) rejectedEffort++
    if (checked.verdict === 'rejected' && !checked.effortRejected) result.inconclusive = ['effort']
    if (checked.verdict === 'inconclusive') interrupted = true
  }

  if (!opts.signal?.aborted) {
    await pause()
    const control = await attempt(profile, '非法值对照', INVALID_EFFORT, opts.signal)
    if (control.verdict === 'rejected') {
      result.probes.push({
        name: '非法值对照',
        ok: true,
        detail: `非法值被拒绝：${control.step.detail}`,
      })
    } else {
      result.inconclusive = ['effort']
      interrupted ||= control.verdict === 'inconclusive'
      result.probes.push({
        name: '非法值对照',
        ok: false,
        inconclusive: true,
        detail:
          control.verdict === 'accepted'
            ? '接口接受了非法档位，参数是否被识别无法确认；不改写档位配置'
            : control.step.detail,
      })
    }
  }
  // 全部请求被拒绝时，只有明确针对 effort 的错误才能收窄档位。
  if (!result.effortLevels.length && rejectedEffort !== levels.length) {
    result.inconclusive = ['effort']
    result.probes.push({
      name: '参数格式',
      ok: false,
      inconclusive: true,
      detail: '请求被拒绝，但未确认是档位参数导致；不改写配置',
    })
  }
  interrupted ||= opts.signal?.aborted === true
  if (interrupted) result.inconclusive = ['effort']
  return { result, interrupted }
}

/** 档位仅保存完整校验；工具检测独立记录实际状态，不裁决运行时能力。 */
export function toTransportCapabilities(outcome: ProbeOutcome): TransportCapabilities {
  const tools = outcome.toolCalls ? { toolCalls: outcome.toolCalls } : {}
  if (!outcome.reachable || outcome.untested.length || outcome.inconclusive.length) return tools
  return {
    ...tools,
    effort: outcome.effortLevels.length > 0,
    effortLevels: [...outcome.effortLevels],
    ...(outcome.thinking ? { thinking: outcome.thinking } : {}),
  }
}

export function describeProbe(
  outcome: ProbeOutcome,
  provider: ProviderKind,
  model: string,
): string {
  const lines = [`${provider} / ${model}`, '']
  for (const step of outcome.probes) {
    const mark = step.skipped ? '–' : step.inconclusive ? '?' : step.ok ? '✓' : '✗'
    lines.push(`  ${mark} ${step.name}  ${step.detail}`)
  }
  const levels =
    outcome.effortLevels.join(' / ') ||
    (outcome.inconclusive.length || outcome.untested.length ? '未确认' : '（不支持）')
  lines.push(
    '',
    `  思考证据：${outcome.thinkingObserved ? '已观察到' : '未观察到'}`,
    `  ${outcome.effortSource === 'catalog' ? '模型库档位校验' : '接口接受的候选值'}：${levels}`,
    ...(outcome.effortSource === 'probe'
      ? ['  参数接受不代表独立强度已确认，接口可能将多个值映射到同一档']
      : []),
    ...(outcome.inconclusive.length ? ['  档位未确认，配置保持不变'] : []),
    ...(outcome.untested.length ? ['  未探测'] : []),
  )
  return lines.join('\n')
}
