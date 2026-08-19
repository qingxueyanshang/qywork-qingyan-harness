#!/usr/bin/env bun

/**
 * 压缩保真度验证。
 *
 * ## 为什么单测不够
 *
 * `compaction.test.ts` 能测「触发了压缩」「manifest 结构正确」「事实包非空」。
 * 它**测不出**压缩后模型还记不记得关键信息——而那才是压缩的全部价值所在。
 *
 * 不做这件事的后果不是「测试覆盖率低」，是**压缩上线后不知道它有没有在悄悄丢信息**：
 * 模型突然忘了用户三十轮前定下的约束，表现是「它怎么把 legacy/ 改了」，
 * 而排查时根本想不到是压缩干的。
 *
 * ## 怎么验
 *
 * 造一段长会话，其中埋入若干**可判定的事实**（约束、路径、决定），
 * 压缩后把投影发给真实模型，逐条问它还记不记得。
 * 记不住的条目就是压缩丢掉的信息。
 *
 *   bun run scripts/compaction-fidelity.ts
 */

import { buildAdapter, estimateText } from '@qywork/ai'
import { loadConfig, makeSummarizer, RuntimeCompaction, resolveModel } from '@qywork/runtime'
import {
  appendMessage,
  ContentStore,
  createConversation,
  listMessages,
  Store,
  upsertWorkspace,
} from '@qywork/store'

/** 埋进会话的可判定事实。`probe` 是压缩后要问的问题，`expect` 是答案里必须出现的关键词。 */
const FACTS = [
  {
    turn: 1,
    text: '重构认证模块，从 session cookie 改成 JWT。注意：绝对不要动 legacy/ 目录下的任何文件。',
    probe: '这次任务里，哪个目录是绝对不能改的？',
    expect: ['legacy'],
  },
  {
    turn: 3,
    text: '签名算法用 RS256，不要用 HS256——我们要支持第三方验签。',
    probe: '约定用的是哪个签名算法？',
    expect: ['RS256'],
  },
  {
    turn: 7,
    text: '数据库迁移必须可回滚，每个 migration 都要写 down。',
    probe: '数据库迁移有什么硬性要求？',
    expect: ['回滚', 'down', 'rollback'],
  },
  {
    turn: 14,
    text: '令牌有效期定为 15 分钟，refresh token 7 天。',
    probe: 'access token 和 refresh token 的有效期分别是多久？',
    expect: ['15'],
  },
  {
    turn: 22,
    text: '前端那边先不用动，等后端稳定了再说。',
    probe: '前端这一轮要不要改？',
    expect: ['不', '先不', '暂'],
  },
]

/** 会话总轮数。要足够长，让上面那些事实真的被压进摘要。 */
const TOTAL_TURNS = 40

/** 只有 message 类标记能在这个夹具里对账——它没有真实 step。 */
function mk_isMessage(id: string): boolean {
  return id.startsWith('ms_')
}

let failures = 0
function check(label: string, ok: boolean, detail?: unknown): void {
  process.stdout.write(`${ok ? '  ✓' : '  ✗'} ${label}\n`)
  if (!ok) {
    failures++
    if (detail !== undefined) process.stdout.write(`      ${String(detail).slice(0, 300)}\n`)
  }
}

async function main(): Promise<number> {
  const config = await loadConfig()
  const profile = resolveModel(config)
  if (!profile) {
    process.stderr.write('没有可用的接口\n')
    return 2
  }

  const store = new Store({ path: ':memory:' })
  const content = new ContentStore(':memory:')
  const ws = upsertWorkspace(store, process.cwd(), 'fidelity')
  const conv = createConversation(store, {
    workspaceId: ws.id,
    provider: profile.provider,
    model: profile.model,
    title: '保真度验证',
  })

  // 造长会话：埋入的事实按 turn 落位，其余轮次是噪音。
  // 噪音不是凑数——没有它，摘要面对的是一份「每句都重要」的输入，
  // 而真实会话里绝大多数内容是可丢的过程性探索。
  for (let i = 1; i <= TOTAL_TURNS; i++) {
    const planted = FACTS.find((f) => f.turn === i)
    appendMessage(store, {
      conversationId: conv.id,
      role: 'user',
      content: planted ? planted.text : `第 ${i} 轮：继续，看看 src/mod${i}.ts 里还有什么要改的。`,
    })
    appendMessage(store, {
      conversationId: conv.id,
      role: 'assistant',
      content: planted
        ? `明白，我记下了。`
        : `我看过 src/mod${i}.ts 了，调整了几处类型标注，没有行为变化。` +
          // 噪音要有真实体积：几十字符的夹具里，摘要与事实清单的固定开销
          // 就超过被折内容，压缩率断言必然失败而线上不会——两者不是一个数量级。
          `具体来说，把 ${i} 处隐式 any 补成了显式类型，${i} 个可选参数补了默认值，` +
          `顺带核对了导出边界。这一轮没有改动运行时行为，测试全绿。`.repeat(4),
    })
  }

  const adapter = buildAdapter({
    kind: profile.kind,
    apiKey: profile.apiKey ?? '',
    model: profile.model,
    ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
  })

  const ask = async (system: string, question: string, maxOut = 500): Promise<string> => {
    let text = ''
    for await (const ev of adapter.stream({
      model: adapter.spec.id,
      system: [{ text: system }],
      messages: [{ role: 'user', content: question }],
      tools: [],
      maxOutputTokens: maxOut,
      signal: AbortSignal.timeout(120_000),
    })) {
      if (ev.type === 'text_delta') text += ev.delta
    }
    return text
  }

  process.stdout.write(`\n造了 ${TOTAL_TURNS} 轮会话，埋入 ${FACTS.length} 条可判定事实\n\n`)

  // ── 压缩 ──
  const realSummarizer = makeSummarizer({
    store,
    workspaceId: ws.id,
    profile: () => ({
      kind: profile.kind,
      apiKey: profile.apiKey ?? '',
      model: profile.model,
      ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
    }),
  })
  const compaction = new RuntimeCompaction({
    store,
    conversationId: conv.id,
    messageIdUpperBound: null,
    /*
     * **走真实装配**，不要在这里自己拼一个摘要器。
     *
     * 自拼的那个不降思考档：配了 `effort: max` 的模型会把输出预算全花在思考上，
     * 正文一个字吐不出来，于是脚本量到的是 `summary_empty` 而线上不是——
     * 验证工具与被验证的东西走两条路，验出来的结论不作数。
     */
    summarize: async (prompt, budgetTokens) => {
      process.stdout.write(
        `  [摘要预算 ${budgetTokens} token · 提示词 ${prompt.length} 字符]
`,
      )
      const out = await realSummarizer(prompt, budgetTokens)
      process.stdout.write(`  [摘要器返回 ${out === null ? 'null' : `${out.length} 字符`}]
`)
      return out
    },
  })

  /*
   * 造一个刚好越线、但摘要仍放得下的窗口。
   *
   * **不要把窗口设成等于占用**：那样软阈值（80%）扣掉保留预算之后几乎不剩空间，
   * 摘要段拿到一个几十 token 的预算，模型一个字都吐不出来，结果是
   * `summary_empty`——而线上 1M 窗口占用 80 万时触发，预算是六位数。
   * 夹具与线上走不同的数量级，验出来的结论不作数。
   *
   * 取 1.2 倍：软阈值 = 0.96×占用（仍越线），保留预算 = 窗口的 1/4，
   * 摘要还剩约六成占用可用。
   */
  const occupancy = listMessages(store, conv.id, null).reduce(
    (n, m) => n + estimateText(m.content),
    0,
  )
  const contextWindow = Math.round(occupancy * 1.2)
  const outcome = await compaction.run({ occupancy, contextWindow })
  if (outcome.status !== 'compacted') {
    process.stderr.write(`压缩未执行：${outcome.status}\n`)
    return 1
  }

  /*
   * **走真实投影**，不要自己拼 `projectManifest`。
   *
   * manifest 现在有两条边界：摘要线与收纳线。只收纳没摘要时摘要线不动，
   * 而 `projectManifest` 无条件产出「摘要 + 事实清单」两条——直接调它，
   * 量到的是一份根本不会发给模型的东西。
   */
  const history = listMessages(store, conv.id, null).map((m) => ({
    role: m.role,
    content: m.content,
    _messageId: m.id,
  }))
  const projected = compaction.project(history)
  const projectedText = projected.map((p) => String(p.content)).join('\n\n')
  const originalChars = FACTS.reduce((n, f) => n + f.text.length, 0) + TOTAL_TURNS * 480
  // 替换物 = 摘要 + 事实清单，即 `projectManifest` 产出的那两条。
  const replacementChars =
    outcome.manifest.summary.length + JSON.stringify(outcome.manifest.facts).length

  process.stdout.write(
    `压缩完成：修订 ${outcome.manifest.revision}，` +
      `摘要段${outcome.summarized ? '跑了' : `没跑（${outcome.reasonCode ?? '未给原因'}）`}，` +
      `摘要 ${outcome.manifest.summary.length} 字符，` +
      `事实包 ${outcome.manifest.facts.userConstraints.length} 条约束\n` +
      `投影总长 ${projectedText.length} 字符（原会话约 ${originalChars} 字符，压到 ${Math.round((projectedText.length / originalChars) * 100)}%）\n\n`,
  )

  // ── 逐条问 ──
  process.stdout.write('压缩后的记忆保真度\n')
  const system =
    '下面是一段被压缩过的会话记录。只根据它回答问题。' +
    '如果记录里没有相关信息，明确回答「记录里没有提到」。\n\n' +
    projectedText

  for (const fact of FACTS) {
    const answer = await ask(system, fact.probe)
    const hit = fact.expect.some((kw) => answer.includes(kw))
    check(`${fact.probe} → ${fact.expect.join(' / ')}`, hit, hit ? undefined : answer)
  }

  /*
   * ── 定位符必须活着穿过摘要 ──
   *
   * 提示词要求模型把 `[message:…]` / `[action:…]` 原样带上，因为那是原文的地址，
   * 模型之后靠它用 `read_history` 回到原文。**提示词写了不等于模型照做**，
   * 而这一条恰恰只有真实调用能验——单测里的假摘要器想输出什么就输出什么。
   *
   * 标记丢了不判失败（与保真度同理，模型有随机性），但必须打出来：
   * 它是「压缩是不是真的可回溯」的唯一实测信号。
   */
  process.stdout.write('\n定位符保留\n')
  /*
   * 两种形式都算数：`[message:ms_x]` 与模型常写的简写 `[ms_x]`。
   * 判据是 **id 完不完整**，不是前缀在不在——`read_history` 要的就是那个 id，
   * 前缀只是给人读的。要求模型逐字照抄前缀反而会让它把 id 也一起改写。
   */
  const marks = [
    ...outcome.manifest.summary.matchAll(/\[(?:(?:message|action):)?((?:ms|rn)_[a-z0-9:]+)\]/gi),
  ].map((m) => m[1] ?? '')
  check(
    `摘要里带回了 ${marks.length} 个定位符`,
    marks.length > 0,
    `摘要前 300 字符：${outcome.manifest.summary.slice(0, 300)}`,
  )
  // 带回来的标记必须指向真实存在的 id，编出来的标记比没有更坏：
  // 模型会拿它去调 read_history，然后拿到一串 not_found。
  const realIds = new Set<string>(listMessages(store, conv.id, null).map((m) => String(m.id)))
  const fabricated = marks.filter((id) => mk_isMessage(id) && !realIds.has(id))
  check('没有编造的定位符', fabricated.length === 0, fabricated.slice(0, 5).join(', '))

  /*
   * ── 压缩率 ──
   *
   * 比的是**被折掉那一段**与替换它的东西，不是「投影 vs 整条原会话」：
   * 保留区原样留在投影里，拿它去比会把一份正常的压缩判成变大了。
   * 这也正是 `compact()` 里「必须更小」闸的口径。
   */
  process.stdout.write('\n压缩率\n')
  const foldedChars = originalChars - projectedText.length + replacementChars
  check(
    '折叠区确实被压小了',
    replacementChars < foldedChars,
    `替换物 ${replacementChars} vs 被折 ${foldedChars}`,
  )

  store.close()
  content.close()

  process.stdout.write(`\n${failures === 0 ? '全部保真' : `${failures} 条信息在压缩中丢失`}\n`)
  // 保真度失败**不返回非零**：模型有随机性，单次未命中不足以判定压缩坏了。
  // 这个脚本的用途是「改压缩策略前后跑一次，看丢失条目有没有变多」。
  return 0
}

process.exit(await main())
