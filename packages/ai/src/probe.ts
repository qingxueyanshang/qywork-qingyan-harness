/**
 * 推理能力探测。
 *
 * 内置目录只认得出自己认识的模型。用户接一个中转站、一个自建网关、一个刚发布的
 * 模型时，`lookupModel` 回落到 `unknownModel()` 的保守默认值：不声明思考、
 * 不声明 effort、计价为 0。保守是对的——**但它是猜的**，而现在没有任何办法验证。
 *
 * 表现：接上一个支持思考的端点，qywork 从不开思考；接上一个不支持的，
 * 又可能因为模型名恰好匹配上内置条目而每次请求都 400。两种都只能靠人试出来。
 *
 * 所以这里做的事只有一件：**发几个极小的请求，看哪些被拒**。
 *
 * - 每个探针的 `max_tokens` 压到最小，prompt 一个字。整轮探测的成本约等于一次问候。
 * - **只由用户显式触发**（`qy probe`）。自动探测意味着有人在不知情的情况下被扣钱，
 *   而且探测结果会在他没改任何配置的时候静默改变行为。
 * - 探不出来的维度**不猜**：上下文窗口、计价、视觉都没法用一个小请求问出来，
 *   思考形态（adaptive / budget_tokens）同样没有观测面——本项目从不请求它，
 *   探针发的 body 与不发时一模一样。所以这里不碰它们。
 *   探测的价值在于它报的每一条都是实测的。
 */

import type { EffortLevel, ProviderKind } from '@qywork/core'
import { ProviderError } from './errors.ts'
import { buildAdapter } from './factory.ts'
import type { ChatRequest, ProviderProfile } from './types.ts'

export interface ProbeOutcome {
  /**
   * 最朴素的那个请求通没通。
   *
   * 与「有没有探出能力」是两码事：一个完全可用但发不出 effort 的端点，
   * 能力一条都探不出来，但它显然是通的。把这两件事混成一个判断，
   * 报出来的就是「端点不通」——而用户会去查一处没坏的配置。
   */
  reachable: boolean
  /**
   * 本协议下客户端不发送、因而**无从探测**的轴。
   *
   * 与「探了、被拒了」是两件完全不同的事，绝不能合并成一个 false——
   * 合并的结果是把「没验过」写成了结论。
   *
   * **思考模式不在这里。** 它没有观测面：本项目从不请求思考形态
   * （`ChatRequest` 里没有那个字段），探针改不了发出去的 body，
   * 因此「端点接受了 adaptive」永远只是 `spec.thinking` 的回声。
   * 把回声写回覆盖层会把参数格式改错，进而把 effort 判死。
   */
  untested: 'effort'[]
  /** 已经尝试，但只得到超时、限速或上游暂不可用，不能据此判成“不支持”。 */
  inconclusive: 'effort'[]
  /** 实测被接受的 effort 档。 */
  effortLevels: EffortLevel[]
  /** 实测什么控制字段都不发时，它是否仍然返回了思考内容。 */
  thinksByDefault: boolean
  /** 每个探针的原始结果，供人核对。**不要只给结论**——结论错了要能查。 */
  probes: ProbeStep[]
}

export interface ProbeStep {
  name: string
  ok: boolean
  detail: string
  /** true = 这一步没有真的验证任何能力（客户端不发这个字段）。 */
  skipped?: boolean
  /** 请求失败但不是字段级 4xx；这一条不能形成能力结论。 */
  inconclusive?: boolean
}

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
): Promise<{
  step: ProbeStep
  thought: boolean
  verdict: 'accepted' | 'rejected' | 'inconclusive'
}> {
  const adapter = buildAdapter(profile)
  let thought = false
  try {
    for await (const ev of adapter.stream(
      tiny(adapter.spec.id, { ...extra, ...(signal ? { signal } : {}) }),
    )) {
      if (ev.type === 'thinking_delta') thought = true
      // 拿到 done 就够了：再读下去不会有新信息，而探测要快。
      if (ev.type === 'done') break
    }
    return { step: { name, ok: true, detail: '接受' }, thought, verdict: 'accepted' }
  } catch (err) {
    // 只有明确的参数 4xx 才能证明控制面被拒。超时、限速、5xx 与中转暂不可用
    // 都是链路状态；把它们写成 effort=false 会让一次抖动永久收起用户控件。
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

  // ── 1. 最朴素的一发能不能跑通，以及它自己会不会思考 ──
  const bare = await attempt(profile, '最小请求', {}, opts.signal)
  probes.push(bare.step)
  const thinksByDefault = bare.thought

  // 连最朴素的请求都被拒 = 这个端点不通（key 错、模型名错、地址错）。
  // 继续探下去只会得到一串同样的错误，而真正该说的是「先解决连通性」。
  if (!bare.step.ok) {
    return {
      reachable: false,
      untested: [],
      inconclusive: [],
      effortLevels: [],
      thinksByDefault: false,
      probes,
    }
  }

  // ── 客户端发不发 effort ──
  //
  // 不发的链路上探针**恒通过**——不是因为端点支持，而是因为请求里没有那个
  // 字段。把这种「通过」写进配置，会用一个凭空的结论覆盖目录里正确的保守值。
  const transmits = buildAdapter(profile).transmits
  const untested: 'effort'[] = transmits.effort ? [] : ['effort']
  const inconclusive: 'effort'[] = []

  /*
   * ── 2. effort 档位 ──
   *
   * **档位表只从内置库取，探测只回答「这条链路接不接受这个控制面」。**
   *
   * 「端点没有 400」永远证明不了一个档存在：OpenAI 兼容端点对不认识的
   * `reasoning_effort` 一律照收后忽略，中转站更是什么都收。遍历全量词表逐档试
   * 的结果是探一次就写回五档，而 grok-4.6 官方只有 low/medium/high/xhigh——
   * 界面照着画出一个厂商没有的档，选了不会有任何反应。
   *
   * 所以：库声明哪几档就试哪几档，**试通一档就整份采纳库的档位**；
   * 连试两档都被拒 = 这条中转不接受这个控制面，报空数组并说清是谁拒的。
   * 不逐档打满还有一个实际好处——请求数从五降到一两次。
   *
   * 库里是空数组（Haiku 4.5、Qwen 那些）= 这个模型本来就没有 effort，
   * 一个请求都不用发。
   */
  const declared = buildAdapter(profile).spec.effortLevels
  let effortLevels: EffortLevel[] = []
  if (declared.length === 0) {
    probes.push({
      name: 'effort',
      ok: false,
      skipped: true,
      detail: '内置库未声明该模型的思考档位',
    })
  } else if (!transmits.effort) {
    // 顺序不能反：档位为空时 `transmits.effort` 也是 false，先判它的话
    // 「库里没有档位」会被报成「参数发不出去」，用户会去改一个没错的字段。
    probes.push({
      name: 'effort',
      ok: false,
      skipped: true,
      detail: '这条协议上该模型发不出 effort 字段，无从探测',
    })
  } else {
    let accepted = false
    let rejected = 0
    let attempted = 0
    // 只试前两档：一档通了就够（控制面成立），两档都被拒就是真不接受。
    for (const level of declared.slice(0, 2)) {
      await pause()
      const r = await attempt(profile, `effort=${level}`, { effort: level }, opts.signal)
      attempted++
      probes.push(r.step)
      if (r.step.ok) {
        accepted = true
        break
      }
      if (r.verdict === 'rejected') rejected++
    }
    if (accepted) {
      effortLevels = [...declared]
    } else if (rejected === attempted) {
      probes.push({
        name: 'effort 控制面',
        ok: false,
        detail: `内置库声明该模型有 ${declared.join(' / ')}，本链路拒绝该字段`,
      })
    } else {
      inconclusive.push('effort')
      probes.push({
        name: 'effort 控制面',
        ok: false,
        inconclusive: true,
        detail: '探测遇到超时、限速或上游暂不可用，未形成能力结论',
      })
    }
  }

  return { reachable: true, untested, inconclusive, effortLevels, thinksByDefault, probes }
}

/**
 * 探测结果里可以安全写回配置的部分。
 *
 * 刻意**不含**上下文窗口与计价：那两样探不出来，写一个猜的值进配置比不写更糟——
 * 它会让「未知计价」变成一个看起来确定的错数字。
 */
export interface ProbedTransportCapabilities {
  /** 当前端点是否接受官方目录声明的 effort 控制面。 */
  effort?: boolean
}

/**
 * 只写回**真的探过**的轴。
 *
 * 没探过的一律不写——留空让目录里的保守默认值继续生效，
 * 比写一个「探针都通过了」的空结论安全得多。
 *
 * **思考参数的格式（`spec.thinking`）不在写回范围内**：它决定 effort 用哪套字段发，
 * 而探测没有观测它的手段。写一个猜的格式回去会把 effort 判死。
 */
export function toTransportCapabilities(o: ProbeOutcome): ProbedTransportCapabilities {
  // 端点不通时这份结果里**没有一项是观测**：`effortLevels: []` 不是
  // 「逐档试过都被拒」，`thinksByDefault: false` 不是「它不思考」，
  // 全是连不上时的占位。整个丢掉，一项都不写。
  if (!o.reachable) return {}

  return o.untested.includes('effort') || o.inconclusive.includes('effort')
    ? {}
    : { effort: o.effortLevels.length > 0 }
}

/** 人读的探测报告。 */
export function describeProbe(o: ProbeOutcome, provider: ProviderKind, model: string): string {
  const lines = [`${provider} / ${model}`, '']
  for (const p of o.probes) {
    const mark = p.skipped ? '–' : p.inconclusive ? '?' : p.ok ? '✓' : '✗'
    lines.push(`  ${mark} ${p.name}${p.ok && !p.skipped ? '' : `  ${p.detail}`}`)
  }
  lines.push(
    '',
    `  省略字段时自己思考：${o.thinksByDefault ? '是' : '否'}`,
    `  可用 effort：${
      o.untested.includes('effort')
        ? '未探测（这条链路不发该字段）'
        : o.inconclusive.includes('effort')
          ? '未得出结论（请求失败）'
          : o.effortLevels.length
            ? o.effortLevels.join(' / ')
            : '（不支持）'
    }`,
  )
  return lines.join('\n')
}
