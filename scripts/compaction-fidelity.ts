#!/usr/bin/env bun

/**
 * 压缩保真度验证。
 *
 * **单元测试的局限。** `compaction.test.ts` 能验证「触发了压缩」「manifest 结构正确」「事实包非空」，
 * 但**无法验证**压缩后模型是否仍记得关键信息，而这正是压缩的全部价值所在。
 *
 * 缺少该验证时，**压缩上线后无法判断它是否在静默丢失信息**：
 * 模型遗忘用户在三十轮之前设定的约束时，
 * 报错与日志中没有任何指向压缩的线索。
 *
 * **验证方法。** 构造一段长会话，其中嵌入若干**可判定的事实**（约束、路径、决定），
 * 压缩后把投影发给真实模型，逐条询问它是否记得。
 * 模型无法回答的条目即为压缩丢失的信息。
 *
 *   bun run scripts/compaction-fidelity.ts
 */

import { createSummaryTrace } from '@qywork/agent'
import { buildAdapter, estimateMessages, STREAM_IDLE_TIMEOUT_MS } from '@qywork/ai'
import {
  buildHistory,
  loadConfig,
  makeSummarizer,
  RuntimeCompaction,
  requestPersistence,
  resolveModel,
} from '@qywork/runtime'
import {
  appendMessage,
  appendStep,
  ContentStore,
  createConversation,
  createRun,
  finishRun,
  listMessages,
  Store,
  upsertWorkspace,
} from '@qywork/store'

/** 嵌入会话的可判定事实。`probe` 是压缩后询问的问题，`expect` 是答案中必须出现的关键词。 */
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

/** 会话总轮数。必须足够长，使上述事实确实被压缩进摘要。 */
const TOTAL_TURNS = 40

/** 只有 message 类标记能在本夹具中核对：本夹具没有真实 step。 */
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

  // 构造长会话：嵌入的事实按 turn 放置，其余轮次为噪声。
  // 噪声不可省略：没有噪声时，摘要面对的是一份「每句都重要」的输入，
  // 而真实会话中绝大多数内容是可丢弃的过程性探索。
  for (let i = 1; i <= TOTAL_TURNS; i++) {
    const planted = FACTS.find((f) => f.turn === i)
    const user = appendMessage(store, {
      conversationId: conv.id,
      role: 'user',
      content: planted ? planted.text : `第 ${i} 轮：继续，看看 src/mod${i}.ts 里还有什么要改的。`,
    })
    // 助手回复按真实结构写入 run 中的 text step，消息表只存储用户消息。
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: profile.model,
      clientRequestId: crypto.randomUUID(),
      userMessageId: user.id,
      messageIdUpperBound: user.id,
      contextSnapshot: [],
    })
    appendStep(store, {
      runId: run.id,
      seq: 1,
      kind: 'text',
      providerBatchId: `pb_${i}`,
      content: planted
        ? `明白，我记下了。`
        : `我看过 src/mod${i}.ts 了，调整了几处类型标注，没有行为变化。` +
          // 噪声必须具有真实体积：只有几十字符的夹具中，摘要与事实清单的固定开销
          // 即超过被折叠的内容，压缩率断言必然失败而线上不会，两者不在同一数量级。
          `具体来说，把 ${i} 处隐式 any 补成了显式类型，${i} 个可选参数补了默认值，` +
          `顺带核对了导出边界。这一轮没有改动运行时行为，测试全绿。`.repeat(4),
    })
    finishRun(store, run.id, { status: 'done', stopReason: 'completed' })
  }
  const history = await buildHistory(store, conv.id, null, async (c) => c)

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
      idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
      signal: AbortSignal.timeout(120_000),
    })) {
      if (ev.type === 'text_delta') text += ev.delta
    }
    return text
  }

  process.stdout.write(`\n造了 ${TOTAL_TURNS} 轮会话，埋入 ${FACTS.length} 条可判定事实\n\n`)

  // ── 压缩 ──
  const realSummarizer = makeSummarizer({
    profile: () => ({
      kind: profile.kind,
      apiKey: profile.apiKey ?? '',
      model: profile.model,
      ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
    }),
    effort: () => profile.effort,
  })
  const compaction = new RuntimeCompaction({
    store,
    conversationId: conv.id,
    messageIdUpperBound: null,
    /*
     * **使用真实装配**，不要在此处自行拼装摘要器。
     *
     * 摘要与线上共用思考档位、输出预算和请求记账；自行拼装请求会使验证测量到另一种行为。
     */
    summarize: async (prompt, budgetTokens, trace) => {
      process.stdout.write(
        `  [摘要预算 ${budgetTokens} token · 提示词 ${prompt.length} 字符]
`,
      )
      const out = await realSummarizer(prompt, budgetTokens, trace)
      process.stdout.write(`  [摘要器返回 ${out === null ? 'null' : `${out.length} 字符`}]
`)
      return out
    },
  })

  /*
   * 构造一个刚好超过阈值、但仍能容纳摘要的窗口。
   *
   * **不要把窗口设为等于占用**：此时软阈值（80%）扣除保留预算之后几乎没有剩余空间，
   * 摘要段仅分配到数十 token 的预算，模型无法产出正文，结果为
   * `summary_empty`；而线上 1M 窗口在占用 80 万时触发，预算为六位数。
   * 夹具与线上的数量级不同时，验证结论无效。
   *
   * 取 1.2 倍：软阈值 = 0.96×占用（仍超过阈值），保留预算 = 窗口的 1/4，
   * 摘要仍有约六成占用的空间可用。
   */
  const occupancy = estimateMessages(history, adapter.spec.density)
  const contextWindow = Math.round(occupancy * 1.2)
  const summaryRun = createRun(store, {
    conversationId: conv.id,
    workspaceId: ws.id,
    model: profile.model,
    clientRequestId: crypto.randomUUID(),
    userMessageId: null,
    messageIdUpperBound: null,
    contextSnapshot: [],
  })
  const outcome = await compaction
    .run({
      trace: createSummaryTrace(
        requestPersistence(store, config),
        summaryRun.id,
        0,
        adapter,
        summaryRun.usage,
        profile.provider,
      ),
      trigger: 'automatic',
      model: adapter.spec.id,
      latestUnitSeen: true,
      occupancy,
      // 此处的占用本身是本地估算值，两种计量一致，比值为 1。
      estimatedOccupancy: occupancy,
      contextWindow,
      density: adapter.spec.density,
    })
    .catch((err: unknown) => {
      finishRun(store, summaryRun.id, { status: 'failed', stopReason: 'provider_error' })
      throw err
    })
  finishRun(store, summaryRun.id, {
    status: outcome.status === 'failed' || outcome.status === 'aborted' ? 'failed' : 'done',
    stopReason:
      outcome.status === 'failed' || outcome.status === 'aborted' ? 'provider_error' : 'completed',
  })
  if (outcome.status !== 'compacted') {
    process.stderr.write(`压缩未执行：${outcome.status}\n`)
    return 1
  }

  /*
   * **使用真实投影**，不要自行调用 `projectManifest` 拼装。
   *
   * manifest 有两条边界：摘要线与收纳线。只收纳而未摘要时摘要线不变，
   * 而 `projectManifest` 无条件产出「摘要 + 事实清单」两项；直接调用它时，
   * 测量的是一份不会发给模型的内容。
   */
  const projected = compaction.project(history)
  const projectedText = projected.map((p) => String(p.content)).join('\n\n')
  const originalChars = FACTS.reduce((n, f) => n + f.text.length, 0) + TOTAL_TURNS * 480
  // 替换内容 = 摘要 + 事实清单，即 `projectManifest` 产出的两项。
  const replacementChars =
    outcome.manifest.summary.length + JSON.stringify(outcome.manifest.facts).length

  process.stdout.write(
    `压缩完成：修订 ${outcome.manifest.revision}，` +
      `摘要段${outcome.summarized ? '跑了' : `没跑（${outcome.reasonCode ?? '未给原因'}）`}，` +
      `摘要 ${outcome.manifest.summary.length} 字符，` +
      `事实包 ${outcome.manifest.facts.userConstraints.length} 条约束\n` +
      `投影总长 ${projectedText.length} 字符（原会话约 ${originalChars} 字符，压到 ${Math.round((projectedText.length / originalChars) * 100)}%）\n\n`,
  )

  // ── 逐条询问 ──
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
   * ── 定位符必须完整穿过摘要 ──
   *
   * 提示词要求模型原样保留 `[message:…]` / `[action:…]`，因为它们是原文的地址，
   * 模型之后依据它们经由 `read_history` 取回原文。**提示词有要求不等于模型遵从**，
   * 而这一项只有真实调用能验证：单元测试中模拟摘要器的输出完全由测试决定。
   *
   * 标记丢失不判定为失败（与保真度同理，模型有随机性），但必须输出：
   * 它是「压缩是否确实可回溯」的唯一实测信号。
   */
  process.stdout.write('\n定位符保留\n')
  /*
   * 两种形式均有效：`[message:ms_x]` 与模型常用的简写 `[ms_x]`。
   * 判据是 **id 是否完整**，不是前缀是否存在：`read_history` 需要的是 id，
   * 前缀只供人阅读。要求模型逐字照抄前缀反而会使它连同 id 一起改写。
   */
  const marks = [
    ...outcome.manifest.summary.matchAll(/\[(?:(?:message|action):)?((?:ms|rn)_[a-z0-9:]+)\]/gi),
  ].map((m) => m[1] ?? '')
  check(
    `摘要里带回了 ${marks.length} 个定位符`,
    marks.length > 0,
    `摘要前 300 字符：${outcome.manifest.summary.slice(0, 300)}`,
  )
  // 摘要返回的标记必须指向真实存在的 id，编造的标记比缺失更有害：
  // 模型会用它调用 read_history，得到的结果全部是 not_found。
  const realIds = new Set<string>(listMessages(store, conv.id, null).map((m) => String(m.id)))
  const fabricated = marks.filter((id) => mk_isMessage(id) && !realIds.has(id))
  check('没有编造的定位符', fabricated.length === 0, fabricated.slice(0, 5).join(', '))

  /*
   * ── 压缩率 ──
   *
   * 比较的是**被折叠的部分**与替换它的摘要，不是「投影与完整原会话」：
   * 保留区原样留在投影中，用投影比较会把正常的压缩误判为变大。
   * 这也是 `compact()` 中「必须更小」检查的口径。
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
  // 保真度失败**不返回非零**：模型有随机性，单次未命中不足以判定压缩有缺陷。
  // 本脚本的用途是在修改压缩策略前后各运行一次，对比丢失条目是否增多。
  return 0
}

process.exit(await main())
