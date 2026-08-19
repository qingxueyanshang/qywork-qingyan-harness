#!/usr/bin/env bun

/**
 * 溢出恢复的真实验证。
 *
 * ## 为什么单测不够
 *
 * 恢复路径的**第一道判据是错误分类**：`classifyProviderError` 认不出这家 provider
 * 的容量拒绝，`capacity` 就是 undefined，凭证不成立，整条恢复路径一次都不会走。
 * 而单测里的假 adapter 抛的是我们自己构造的错误——**它必然认得**，
 * 于是测试全绿而线上会话照旧卡死。
 *
 * 这个脚本发一个真的超窗请求，看真实 provider 回什么、我们认不认得。
 *
 *   bun run scripts/overflow-recovery.ts
 */

import { buildAdapter, classifyProviderError, ProviderError } from '@qywork/ai'
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
   * 造一份必然超窗的请求。
   *
   * 按**字符**堆到窗口的两倍以上：本地估算对 CJK 是 1.5 token/字，
   * 这里用 ASCII（4 字符/token）堆，字符数取 `窗口 × 4 × 2`，
   * 保证无论哪把尺量都远超上限。
   */
  const filler = 'x'.repeat(window * 4 * 2)
  process.stdout.write(`发一个约 ${(filler.length / 4).toLocaleString()} token 的请求…\n`)

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
     * 没报错 = **静默溢出**：provider 悄悄截断超出部分，照常返回。
     *
     * 这种 provider 上「靠错误分类拿凭证」的恢复路径一次都不会触发，
     * 而会话已经在丢上下文——模型看到的历史被砍掉一截，它不知道，我们也不知道。
     * 判据只能从 usage 真值反推：自报输入远小于实际发出的量即为截断。
     */
    process.stdout.write(
      `  它没有报错。stopReason=${stop} · provider 自报输入 ${reported.toLocaleString()}` +
        ` / 窗口 ${window.toLocaleString()} / 实际发出约 ${Math.round(filler.length / 4).toLocaleString()}\n`,
    )
    /*
     * 判据是**自报输入有没有顶到窗口**，不是「自报够不够大」。
     *
     * 顶到窗口而实际发出的远不止这么多，只有一种解释：provider 把超出的
     * 部分丢了。两个数都是真值（provider 自报 + 模型自带窗口），没有人为阈值。
     */
    check(
      '没有被静默截断（自报输入未顶到窗口）',
      reported < window,
      `自报 ${reported} 已顶到窗口 ${window}，而实际发出约 ${Math.round(filler.length / 4)}——超出的部分被丢了`,
    )
    process.stdout.write(
      `\n${failures === 0 ? '这家 provider 真的吃下了超窗请求，窗口值偏保守' : '这家 provider 静默截断：错误分类拿不到凭证，恢复必须靠 usage 真值反推'}\n`,
    )
    return failures === 0 ? 0 : 1
  }

  const classified =
    caught instanceof ProviderError ? caught : classifyProviderError(adapter.spec.provider, caught)
  const pe = classified instanceof ProviderError ? classified : null

  process.stdout.write(`  provider 原文：${String((caught as Error).message).slice(0, 200)}\n`)
  check('归类成 context_overflow', pe?.code === 'context_overflow', pe?.code)

  /*
   * `capacity` 是恢复的**凭证**，不是附加信息。
   *
   * `loop.ts` 的判据是 `code === 'context_overflow' && pe.capacity`：
   * 只看 code 不够，泛化的 400 也可能带这个码。缺了 capacity，
   * 恢复一次都不会触发，会话撞窗即死。
   */
  check(
    '带上了 capacity 凭证（恢复的判据）',
    pe?.capacity !== undefined,
    JSON.stringify(pe?.detail),
  )
  if (pe?.capacity) {
    const c = pe.capacity
    process.stdout.write(
      `      provider 自报：输入 ${c.reportedInputTokens ?? '未报'}` +
        ` / 上限 ${c.reportedLimitTokens ?? '未报'} · 口径 ${c.scope}` +
        ` · 原生码 ${c.providerCode ?? '无'}\n`,
    )
    // 自报输入量用来校正锚点。拿不到不致命（退回估算），但拿得到就该是真值。
    check(
      '自报输入量可用于校正锚点（拿不到则退回估算）',
      c.reportedInputTokens === null || c.reportedInputTokens > 0,
      c.reportedInputTokens,
    )
  }

  process.stdout.write(
    `\n${failures === 0 ? '恢复凭证成立：撞窗后 loop 会压一次再重发' : `${failures} 项不成立，恢复路径在这家 provider 上是死的`}\n`,
  )
  return failures === 0 ? 0 : 1
}

process.exit(await main())
