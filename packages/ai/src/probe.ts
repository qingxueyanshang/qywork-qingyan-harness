/** 已声明模型按库中档位校验，未声明模型尝试五档。仅由用户显式触发。 */
import { EFFORT_ORDER, type EffortLevel, type ProviderKind, type ThinkingMode } from '@qywork/core'
import { declaredEffortLevels, effortIsTransmittable, lookupModel } from './catalog.ts'
import { ProviderError } from './errors.ts'
import { buildAdapter } from './factory.ts'
import { STREAM_IDLE_TIMEOUT_MS } from './transport.ts'
import type { ChatRequest, ProviderProfile, TransportCapabilities } from './types.ts'

const LEVELS = EFFORT_ORDER.filter((level) => level !== 'minimal')
const INVALID_EFFORT = '__qy_probe_invalid_effort__'

export interface ProbeOutcome {
  reachable: boolean
  untested: 'effort'[]
  /** 超时、限速或非法值也被接受时，不能据此改写配置。 */
  inconclusive: 'effort'[]
  /** catalog = 模型库声明的档位；probe = 接口接受的候选值，独立强度未确认。 */
  effortSource: 'catalog' | 'probe'
  effortLevels: EffortLevel[]
  /** 本次实际发送参数所用的格式。仅在探测有明确结论时写回。 */
  thinking?: ThinkingMode
  thinksByDefault: boolean
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
): Promise<{ step: ProbeStep; thought: boolean; verdict: Verdict }> {
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
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxOutputTokens: 16,
      idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
      ...(effort ? { effort } : {}),
      ...(signal ? { signal } : {}),
    }
    for await (const ev of adapter.stream(request)) {
      if (ev.type === 'thinking_delta') thought = true
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
      thought: false,
      verdict: rejected ? 'rejected' : 'inconclusive',
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
    thinksByDefault: bare.thought,
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
  // 未收录模型也发协议对应的字段，不再要求内置目录预先声明档位。
  const thinking: ThinkingMode =
    seed.catalogued !== false ||
    declared.spec?.thinking !== undefined ||
    declared.kind === 'anthropic_messages'
      ? spec.thinking
      : 'reasoning_effort'
  if (!effortIsTransmittable({ ...spec, thinking, effortLevels: levels ?? LEVELS })) {
    outcome.untested = ['effort']
    outcome.probes.push({
      name: '思考档位',
      ok: false,
      skipped: true,
      detail: '模型库声明的思考参数格式无法通过当前协议发送',
    })
    return outcome
  }
  const probing: ProviderProfile = { ...declared, spec: { ...declared.spec, thinking } }
  outcome.thinking = thinking
  const pause = () => new Promise((resolve) => setTimeout(resolve, opts.gapMs ?? 300))
  for (const level of levels ?? LEVELS) {
    if (opts.signal?.aborted) {
      outcome.inconclusive = ['effort']
      break
    }
    await pause()
    const result = await attempt(probing, `effort=${level}`, level, opts.signal)
    outcome.probes.push(result.step)
    if (result.verdict === 'accepted') outcome.effortLevels.push(level)
    if (result.verdict === 'inconclusive') outcome.inconclusive = ['effort']
  }

  if (!opts.signal?.aborted) {
    await pause()
    const control = await attempt(probing, '非法值对照', INVALID_EFFORT, opts.signal)
    if (control.verdict === 'rejected') {
      outcome.probes.push({
        name: '非法值对照',
        ok: true,
        detail: `非法值被拒绝：${control.step.detail}`,
      })
    } else {
      outcome.inconclusive = ['effort']
      outcome.probes.push({
        name: '非法值对照',
        ok: false,
        inconclusive: true,
        detail:
          control.verdict === 'accepted'
            ? '接口连非法档位也接受，可能忽略或映射参数；已接受的档位尚不能确认为有效'
            : control.step.detail,
      })
    }
  }
  return outcome
}

/** 只保存一次完整、且能拒绝非法值的校验；部分失败时保留上次配置。 */
export function toTransportCapabilities(outcome: ProbeOutcome): TransportCapabilities {
  if (!outcome.reachable || outcome.untested.length || outcome.inconclusive.length) return {}
  return {
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
    `  省略字段时自己思考：${outcome.thinksByDefault ? '是' : '未观察到'}`,
    `  ${outcome.effortSource === 'catalog' ? '模型库档位校验' : '接口接受的候选值'}：${levels}`,
    ...(outcome.effortSource === 'probe'
      ? ['  参数接受不代表独立强度已确认，接口可能将多个值映射到同一档']
      : []),
    ...(outcome.inconclusive.length ? ['  档位未确认，配置保持不变'] : []),
    ...(outcome.untested.length ? ['  未探测'] : []),
  )
  return lines.join('\n')
}
