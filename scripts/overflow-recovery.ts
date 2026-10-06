#!/usr/bin/env bun

/**
 * 溢出恢复的真实端点验证。
 *
 * **单元测试无法覆盖的部分。** 恢复路径的首个判据是错误分类：`classifyProviderError` 无法识别该
 * provider 的容量拒绝时，`capacity` 为 undefined，恢复依据不成立，恢复路径不会执行。单元测试中的
 * 模拟 adapter 抛出的是测试构造的错误，分类器必然能识别，因此测试全部通过而真实会话仍然停滞。
 *
 * 本脚本发送一个超出上下文窗口的真实请求，检查 provider 返回的内容以及分类器能否识别。
 *
 *   bun run scripts/overflow-recovery.ts
 */

import {
  buildAdapter,
  classifyProviderError,
  ProviderError,
  STREAM_IDLE_TIMEOUT_MS,
} from '@qywork/ai'
import { loadConfig, resolveModel } from '@qywork/runtime'

let failures = 0
function check(label: string, ok: boolean, detail?: unknown): void {
  process.stdout.write(`${ok ? '  ✓' : '  ✗'} ${label}\n`)
  if (!ok) {
    failures++
    if (detail !== undefined) process.stdout.write(`      ${String(detail).slice(0, 400)}\n`)
  }
}

async function main(): Promise<number> {
  const config = await loadConfig()
  const profile = resolveModel(config)
  if (!profile) {
    process.stderr.write('没有可用的接口\n')
    return 2
  }

  const adapter = buildAdapter({
    kind: profile.kind,
    apiKey: profile.apiKey ?? '',
    model: profile.model,
    ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
  })

  const window = adapter.spec.contextWindow
  process.stdout.write(
    `\n模型 ${adapter.spec.id} · 协议 ${adapter.spec.provider} · 窗口 ${window.toLocaleString()}\n\n`,
  )

  /*
   * 构造一个必然超出上下文窗口的请求。
   *
   * 按字符数填充到窗口的两倍以上：本地估算对 CJK 按 1.5 token/字计算，
   * 此处用 ASCII（4 字符/token）填充，字符数取 `窗口 × 4 × 2`，
   * 保证无论按哪种估算方式都远超上限。
   */
  const filler = 'x'.repeat(window * 4 * 2)
  process.stdout.write(`发送约 ${(filler.length / 4).toLocaleString()} token 的请求…\n`)

  let caught: unknown = null
  let stop = ''
  let reported = 0
  try {
    for await (const ev of adapter.stream({
      model: adapter.spec.id,
      system: [{ text: '回答一个字。' }],
      messages: [{ role: 'user', content: filler }],
      tools: [],
      maxOutputTokens: 16,
      idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
      signal: AbortSignal.timeout(180_000),
    })) {
      if (ev.type === 'done') stop = ev.stopReason
      else if (ev.type === 'usage') {
        reported = ev.usage.inputTokens + (ev.usage.cachedTokens ?? 0)
      }
    }
  } catch (err) {
    caught = err
  }

  process.stdout.write('\n错误分类\n')
  if (!caught) {
    /*
     * 未报错即静默溢出：provider 直接截断超出部分并照常返回。
     *
     * 此类 provider 上依赖错误分类的恢复路径不会触发，
     * 而会话已在丢失上下文：部分历史被截断，模型侧与本地均无任何信号。
     * 判据只能由 usage 真值反推：自报输入远小于实际发出的量即为截断。
     */
    process.stdout.write(
      `  未报错。stopReason=${stop} · provider 自报输入 ${reported.toLocaleString()}` +
        ` / 窗口 ${window.toLocaleString()} / 实际发出约 ${Math.round(filler.length / 4).toLocaleString()}\n`,
    )
    /*
     * 判据是自报输入是否达到窗口上限，而不是自报值是否足够大。
     *
     * 自报输入达到窗口上限而实际发出量远超于此，说明 provider 丢弃了超出的
     * 部分。两个数都是真值（provider 自报值与模型自带窗口），不含人为阈值。
     */
    check(
      '未被静默截断（自报输入未达到窗口上限）',
      reported < window,
      `自报 ${reported} 已达到窗口上限 ${window}，而实际发出约 ${Math.round(filler.length / 4)}，超出部分已被丢弃`,
    )
    process.stdout.write(
      `\n${failures === 0 ? '该 provider 接受了超出窗口的请求，窗口值偏保守' : '该 provider 静默截断：错误分类无法取得恢复依据，恢复只能依据 usage 真值反推'}\n`,
    )
    return failures === 0 ? 0 : 1
  }

  const classified =
    caught instanceof ProviderError ? caught : classifyProviderError(adapter.spec.provider, caught)
  const pe = classified instanceof ProviderError ? classified : null

  process.stdout.write(`  provider 原文：${String((caught as Error).message).slice(0, 200)}\n`)
  check('归类为 context_overflow', pe?.code === 'context_overflow', pe?.code)

  /*
   * `capacity` 是恢复的必要依据，不是附加信息。
   *
   * `agent/loop/attempt.ts` 的判据是 `code === 'context_overflow' && pe.capacity`：
   * 只检查 code 不够，泛化的 400 也可能带有该错误码。缺少 capacity 时，
   * 恢复不会触发，会话超出上下文窗口后无法恢复。
   */
  check('带有 capacity（恢复的判据）', pe?.capacity !== undefined, JSON.stringify(pe?.detail))
  if (pe?.capacity) {
    const c = pe.capacity
    process.stdout.write(
      `      provider 自报：输入 ${c.reportedInputTokens ?? '未报'}` +
        ` / 上限 ${c.reportedLimitTokens ?? '未报'} · 口径 ${c.scope}` +
        ` · 原生码 ${c.providerCode ?? '无'}\n`,
    )
    // 自报输入量用于校正锚点。无法取得时不影响执行（回退到估算），取得时必须是真值。
    check(
      '自报输入量可用于校正锚点（无法取得时回退到估算）',
      c.reportedInputTokens === null || c.reportedInputTokens > 0,
      c.reportedInputTokens,
    )
  }

  process.stdout.write(
    `\n${failures === 0 ? '恢复依据成立：触及窗口上限后 loop 压缩一次再重发' : `${failures} 项不成立，恢复路径在该 provider 上不可达`}\n`,
  )
  return failures === 0 ? 0 : 1
}

process.exit(await main())
