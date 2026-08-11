/**
 * 推理能力探测。
 *
 * 内置目录只认得出自己认识的模型。用户接一个中转站、一个自建网关、一个刚发布的
 * 模型时，`lookupModel` 回落到 `unknownModel()` 的保守默认值：不声明思考、
 * 不声明 effort、计价为 0。保守是对的——**但它是猜的**，而现在没有任何办法验证。
 *
 * 表现：接上一个其实支持思考的端点，qywork 从不开思考；接上一个不支持的，
 * 又可能因为模型名恰好匹配上内置条目而每次请求都 400。两种都只能靠人试出来。
 *
 * 所以这里做的事只有一件：**发几个极小的请求，看哪些被拒**。
 *
 * - 每个探针的 `max_tokens` 压到最小，prompt 一个字。整轮探测的成本约等于一次问候。
 * - **只由用户显式触发**（`qy probe`）。自动探测意味着有人在不知情的情况下被扣钱，
 *   而且探测结果会在他没改任何配置的时候悄悄改变行为。
 * - 探不出来的维度**不猜**：上下文窗口、计价、视觉都没法用一个小请求问出来，
 *   所以这里根本不碰它们。探测的价值在于它报的每一条都是实测的。
 */

import type { EffortLevel, ProviderKind, ThinkingMode } from './catalog.ts'
import { buildAdapter } from './factory.ts'
import type { ChatRequest, ProviderProfile } from './types.ts'

export interface ProbeOutcome {
  /**
   * 最朴素的那个请求通没通。
   *
   * 与「有没有探出能力」是两码事：一个完全可用但不传 thinking 字段的端点，
   * 能力一条都探不出来，但它显然是通的。把这两件事混成一个判断，
   * 报出来的就是「端点不通」——而用户会去查一个根本没坏的东西。
   */
  reachable: boolean
  /**
   * 实测可用的思考模式。
   * `null` = 每种都被拒；`undefined` 语义不同，见 `untested`。
   */
  thinking: ThinkingMode | null
  /**
   * 本协议下客户端根本不发送、因而**无从探测**的轴。
   *
   * 与「探了、被拒了」是两件完全不同的事，绝不能合并成一个 false——
   * 合并的结果是把「没验过」写成了结论。
   */
  untested: ('thinking' | 'effort')[]
  /** 实测被接受的 effort 档。 */
  effortLevels: EffortLevel[]
  /** 实测省略 thinking 字段时是否仍然返回了思考内容。 */
  thinksByDefault: boolean
  /** 每个探针的原始结果，供人核对。**不要只给结论**——结论错了要能查。 */
  probes: ProbeStep[]
}

export interface ProbeStep {
  name: string
  ok: boolean
  detail: string
  /** true = 这一步没有真的验证任何东西（客户端不发这个字段）。 */
  skipped?: boolean
}

const ALL_EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** 一次探针请求：一个字的输入、最小的输出。 */
function tiny(model: string, extra: Partial<ChatRequest>): ChatRequest {
  return {
    model,
    system: [],
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    maxOutputTokens: 16,
    ...extra,
  }
}

/**
 * 跑一个探针。
 *
 * 判据是**这次请求有没有被拒**，不是它回了什么内容——内容因模型而异，
 * 而「400 了」是所有 provider 都一致的信号。
 */
async function attempt(
  profile: ProviderProfile,
  name: string,
  extra: Partial<ChatRequest>,
  signal?: AbortSignal,
): Promise<{ step: ProbeStep; thought: boolean }> {
  const adapter = buildAdapter(profile)
  let thought = false
  try {
    for await (const ev of adapter.stream(
      tiny(adapter.spec.id, { ...extra, ...(signal ? { signal } : {}) }),
    )) {
      if (ev.type === 'thinking_delta') thought = true
      // 拿到 done 就够了：再读下去只是白等，而探测要快。
      if (ev.type === 'done') break
    }
    return { step: { name, ok: true, detail: '接受' }, thought }
  } catch (err) {
    return {
      step: { name, ok: false, detail: err instanceof Error ? err.message : String(err) },
      thought: false,
    }
  }
}

export interface ProbeOptions {
  signal?: AbortSignal
  /** 每个探针之间歇一下，避免撞限速。默认 300ms。 */
  gapMs?: number
}

export async function probeModel(
  profile: ProviderProfile,
  opts: ProbeOptions = {},
): Promise<ProbeOutcome> {
  const probes: ProbeStep[] = []
  const gap = opts.gapMs ?? 300
  const pause = () => new Promise((r) => setTimeout(r, gap))

  // ── 1. 省略 thinking 字段能不能跑通，以及它自己会不会思考 ──
  const bare = await attempt(profile, '不带 thinking 字段', {}, opts.signal)
  probes.push(bare.step)
  const thinksByDefault = bare.thought

  // 连最朴素的请求都被拒 = 这个端点根本不通（key 错、模型名错、地址错）。
  // 继续探下去只会得到一串同样的错误，而真正该说的是「先把连通性弄好」。
  if (!bare.step.ok) {
    return {
      reachable: false,
      thinking: null,
      untested: [],
      effortLevels: [],
      thinksByDefault: false,
      probes,
    }
  }

  // ── 客户端到底发不发这些字段 ──
  //
  // OpenAI 兼容协议下本客户端不发 thinking / effort，所以那些探针**恒通过**——
  // 不是因为端点支持，而是因为请求里压根没有那个字段。
  // 把这种「通过」写进配置，会用一个凭空的结论覆盖目录里正确的保守值。
  const transmits = buildAdapter(profile).transmits
  const untested: ('thinking' | 'effort')[] = []
  if (!transmits.thinking) untested.push('thinking')
  if (!transmits.effort) untested.push('effort')

  if (!transmits.thinking && !transmits.effort) {
    probes.push({
      name: 'thinking / effort',
      ok: false,
      skipped: true,
      detail: '本协议下客户端不发送这两个字段，无从探测',
    })
    return { reachable: true, thinking: null, untested, effortLevels: [], thinksByDefault, probes }
  }

  // ── 2. 思考模式：从新到旧试 ──
  //
  // 顺序不能反。`adaptive` 是当前形态，`budget_tokens` 是老形态；
  // 先试老的会在新模型上拿到一个 400，然后误判成「不支持思考」。
  let thinking: ThinkingMode | null = null
  if (!transmits.thinking) {
    probes.push({
      name: 'thinking',
      ok: false,
      skipped: true,
      detail: '本协议下客户端不发送 thinking 字段，无从探测',
    })
  } else {
    await pause()
    const adaptive = await attempt(
      profile,
      'thinking=adaptive',
      { thinking: { mode: 'adaptive' } },
      opts.signal,
    )
    probes.push(adaptive.step)

    if (adaptive.step.ok) {
      thinking = 'adaptive_only'
    } else {
      await pause()
      const budget = await attempt(
        profile,
        'thinking=budget_tokens',
        { thinking: { mode: 'budget', budgetTokens: 1024 } },
        opts.signal,
      )
      probes.push(budget.step)
      if (budget.step.ok) thinking = 'budget_tokens'
    }

    // ── 3. 能不能关掉思考 ──
    //
    // 关不掉是一种**能力事实**（Fable 5 就是这样），不是失败。
    // 报成 `always_on` 而不是「不支持思考」——两者对装配的影响完全相反。
    if (thinking === null && thinksByDefault) {
      thinking = 'always_on'
    } else if (thinking !== null) {
      await pause()
      const off = await attempt(
        profile,
        'thinking=disabled',
        { thinking: { mode: 'disabled' } },
        opts.signal,
      )
      probes.push(off.step)
      if (!off.step.ok) thinking = 'always_on'
    }
    if (thinking === null) thinking = thinksByDefault ? 'always_on' : 'none'
  }

  // ── 4. effort 档位 ──
  //
  // 逐档试。不是「试一个通了就假设全通」——实测过 Opus 5 关思考时
  // 只到 high，xhigh/max 会 400，这种半支持只有逐档试才看得出来。
  const effortLevels: EffortLevel[] = []
  if (!transmits.effort) {
    probes.push({
      name: 'effort',
      ok: false,
      skipped: true,
      detail: '本协议下客户端不发送 effort 字段，无从探测',
    })
  } else
    for (const level of ALL_EFFORTS) {
      await pause()
      const r = await attempt(profile, `effort=${level}`, { effort: level }, opts.signal)
      probes.push(r.step)
      if (r.step.ok) effortLevels.push(level)
    }

  return { reachable: true, thinking, untested, effortLevels, thinksByDefault, probes }
}

/**
 * 探测结果里可以安全写回配置的部分。
 *
 * 刻意**不含**上下文窗口与计价：那两样探不出来，写一个猜的值进配置比不写更糟——
 * 它会让「未知计价」变成一个看起来确定的错数字。
 */
export interface ProbedCapabilities {
  thinking?: ThinkingMode
  effortLevels?: EffortLevel[]
  thinksByDefault?: boolean
}

/**
 * 只写回**真的探过**的轴。
 *
 * 没探过的一律不写——留空让目录里的保守默认值继续生效，
 * 比写一个「探针都通过了」的空结论安全得多。
 *
 * 但「没探过」要按轴分清楚。`thinksByDefault` 与另外两轴**不是一回事**：
 * 它是从**回包**里观测出来的（什么都不发，看它自己吐不吐思考内容），
 * 跟我们发不发 `thinking` 字段毫无关系。之前它被绑在 `thinking` 轴上一起丢掉，
 * 后果在 DeepSeek 上就能看见：探针明明测出「省略字段时自己思考：是」，
 * `--save` 却什么都不写，目录里那条错误的 `thinksByDefault: false` 原样留着。
 *
 * 一个测出来了却被扔掉的事实，和一个没测的事实，不该受同样的待遇。
 */
export function toCapabilities(o: ProbeOutcome): ProbedCapabilities {
  // 端点不通时这份结果里**没有一项是观测**：`effortLevels: []` 不是
  // 「逐档试过都被拒」，`thinksByDefault: false` 不是「它不思考」，
  // 全是连不上时的占位。整个丢掉，一项都不写。
  if (!o.reachable) return {}

  const untested = new Set(o.untested)
  return {
    ...(o.thinking && !untested.has('thinking') ? { thinking: o.thinking } : {}),
    ...(untested.has('effort') ? {} : { effortLevels: o.effortLevels }),
    thinksByDefault: o.thinksByDefault,
  }
}

/** 人读的探测报告。 */
export function describeProbe(o: ProbeOutcome, provider: ProviderKind, model: string): string {
  const lines = [`${provider} / ${model}`, '']
  for (const p of o.probes) {
    const mark = p.skipped ? '–' : p.ok ? '✓' : '✗'
    lines.push(`  ${mark} ${p.name}${p.ok && !p.skipped ? '' : `  ${p.detail}`}`)
  }
  const untested = new Set(o.untested)
  lines.push(
    '',
    `  思考模式：${untested.has('thinking') ? '未探测（本协议不发该字段）' : (o.thinking ?? '（端点不通，未能判定）')}`,
    `  省略字段时自己思考：${o.thinksByDefault ? '是' : '否'}`,
    `  可用 effort：${
      untested.has('effort')
        ? '未探测（本协议不发该字段）'
        : o.effortLevels.length
          ? o.effortLevels.join(' / ')
          : '（不支持）'
    }`,
  )
  return lines.join('\n')
}
