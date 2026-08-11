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

import { projectManifest } from '@qywork/agent'
import { buildAdapter } from '@qywork/ai'
import { loadConfig, RuntimeCompaction, resolveApiKey } from '@qywork/runtime'
import {
  appendMessage,
  ContentStore,
  createConversation,
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
  const profile = config.profiles[config.active]
  if (!profile) {
    process.stderr.write('没有可用的供应商档案\n')
    return 2
  }

  const store = new Store({ path: ':memory:' })
  const content = new ContentStore(':memory:')
  const ws = upsertWorkspace(store, process.cwd(), 'fidelity')
  const conv = createConversation(store, {
    workspaceId: ws.id,
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
        : `我看过 src/mod${i}.ts 了，调整了几处类型标注，没有行为变化。`,
    })
  }

  const adapter = buildAdapter({
    kind: profile.kind,
    apiKey: resolveApiKey(profile),
    model: profile.model,
    ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
  })

  const ask = async (system: string, question: string): Promise<string> => {
    let text = ''
    for await (const ev of adapter.stream({
      model: adapter.spec.id,
      system: [{ text: system }],
      messages: [{ role: 'user', content: question }],
      tools: [],
      maxOutputTokens: 500,
      signal: AbortSignal.timeout(120_000),
    })) {
      if (ev.type === 'text_delta') text += ev.delta
    }
    return text
  }

  process.stdout.write(`\n造了 ${TOTAL_TURNS} 轮会话，埋入 ${FACTS.length} 条可判定事实\n\n`)

  // ── 压缩 ──
  const compaction = new RuntimeCompaction({
    store,
    conversationId: conv.id,
    messageIdUpperBound: null,
    summarize: async (prompt, budget) => {
      const out = await ask('你是会话摘要器。只输出摘要正文。', prompt)
      return out.slice(0, budget) || null
    },
  })

  const outcome = await compaction.run()
  if (outcome.status !== 'compacted') {
    process.stderr.write(`压缩未执行：${outcome.status}\n`)
    return 1
  }

  const projected = projectManifest(outcome.manifest)
  const projectedText = projected.map((p) => p.content).join('\n\n')
  const originalChars = FACTS.reduce((n, f) => n + f.text.length, 0) + TOTAL_TURNS * 60

  process.stdout.write(
    `压缩完成：修订 ${outcome.manifest.revision}，摘要 ${outcome.manifest.summary.length} 字符，` +
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

  // ── 压缩率必须是真的省了 ──
  process.stdout.write('\n压缩率\n')
  check(
    '投影确实比原会话短',
    projectedText.length < originalChars,
    `${projectedText.length} vs ${originalChars}`,
  )

  store.close()
  content.close()

  process.stdout.write(`\n${failures === 0 ? '全部保真' : `${failures} 条信息在压缩中丢失`}\n`)
  // 保真度失败**不返回非零**：模型有随机性，单次未命中不足以判定压缩坏了。
  // 这个脚本的用途是「改压缩策略前后跑一次，看丢失条目有没有变多」。
  return 0
}

process.exit(await main())
