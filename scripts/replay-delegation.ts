#!/usr/bin/env bun
/**
 * 真机全场景复刻：用户原话起一轮，真实模型、真实子 agent，服务与账本另起一份不碰 `~/.qywork`。
 *
 * 验的是单元测试验不到的一段：模型按运行快照建临时子 agent 而不建角色、四个模型各归各、
 * 四个子 agent 并行起跑且状态当场落库；中断之后一句「继续」续跑原来那四个子 agent，
 * 不另起四个；最后父会话自己验收。
 *
 *   bun run scripts/replay-delegation.ts                  # 首派 → 中断 → 继续 → 验收
 *   bun run scripts/replay-delegation.ts --no-interrupt   # 首派 → 验收
 *   bun run scripts/replay-delegation.ts --round-min=120  # 一轮最多等多少分钟，默认 45
 *
 * 配置（含密钥）读 `~/.qywork/config.json`；工作区与账本落 `.tmp/replay-ws/<时间戳>/`，跑完不删。
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentEvent, ConversationId, ConversationSubagentsResponse } from '@qywork/core'
import { loadConfig } from '@qywork/runtime'
import { serve } from '@qywork/server'
import { getConversation, listChildConversations, listRuns, listSteps, Store } from '@qywork/store'

/** 每次跑一个带时间戳的目录，旧的一律留着：账本是事后排查子 agent 为什么停的唯一证据。 */
const ROOT = join(
  import.meta.dir,
  '..',
  '.tmp',
  'replay-ws',
  new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-'),
)
const WS_DIR = join(ROOT, 'racer')
const DB = join(ROOT, 'replay.sqlite3')

/** 用户原话，一字不改。 */
const INSTRUCTION =
  '帮我设立4个子agent，然后分别安排glm5.3flash、qwen3.8flash、deepseek4.0flash version、Gemini3.8flash\n' +
  '同时做一个赛车游戏，要3d的，漫画风格，最后你来做验收和横向对比，主要是看游戏有没有bug还有可玩性，有bug让他们继续优化,，利用workflow的功能，来完成这件事'

/** 用户点名的四个模型在配置里的 id。deepseek 那个用户写的是「4.0flash version」，两个 flash 都认。 */
const EXPECTED_MODELS: { name: string; matches: (model: string) => boolean }[] = [
  { name: 'glm-5.3-flash', matches: (m) => m === 'glm-5.3-flash' },
  { name: 'qwen3.8-flash', matches: (m) => m === 'qwen3.8-flash' },
  { name: 'deepseek-v4-flash*', matches: (m) => m.startsWith('deepseek-v4-flash') },
  { name: 'gemini-3.8-flash', matches: (m) => m === 'gemini-3.8-flash' },
]

const INTERRUPT = !process.argv.includes('--no-interrupt')
/** 四个都跑起来之后再等这么久才中断：要让它们各自留下一段真实上下文。 */
const INTERRUPT_AFTER_MS = 120_000
const FIRST_DISPATCH_TIMEOUT_MS = 6 * 60_000
const ROUND_TIMEOUT_MS =
  Number(
    process.argv.find((a) => a.startsWith('--round-min='))?.slice('--round-min='.length) || 45,
  ) * 60_000

type Started = Extract<AgentEvent, { type: 'tool.started' }>
type Finished = Extract<AgentEvent, { type: 'tool.finished' }>
type Member = Extract<AgentEvent, { type: 'team.member' }>

let failures = 0
function check(label: string, ok: boolean, detail?: unknown): void {
  process.stdout.write(`${ok ? '  ✓' : '  ✗'} ${label}\n`)
  if (!ok) {
    failures++
    if (detail !== undefined)
      process.stdout.write(`      ${JSON.stringify(detail).slice(0, 800)}\n`)
  }
}
const stamp = () => new Date().toISOString().slice(11, 19)
const log = (line: string) => process.stdout.write(`[${stamp()}] ${line}\n`)

async function main(): Promise<number> {
  await mkdir(WS_DIR, { recursive: true })

  const store = new Store({ path: DB })
  const config = await loadConfig()
  const h = serve({ store, config, workspaceRoot: WS_DIR, port: 0, host: '127.0.0.1' })
  const base = `http://127.0.0.1:${h.port}`
  const auth = { authorization: `Bearer ${h.token}` }
  log(
    `服务已起：${base}（父会话模型 ${config.active.provider} / ${config.active.model}）；账本 ${DB}`,
  )

  try {
    const created = (await (
      await fetch(`${base}/api/conversations`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ title: '真机复刻' }),
      })
    ).json()) as { conversation?: { id?: string } }
    const conversationId = (created.conversation?.id ?? '') as ConversationId
    if (!conversationId) throw new Error('建会话失败')

    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/stream?token=${h.token}&origin=desktop`)
    await new Promise<void>((res, rej) => {
      ws.addEventListener('open', () => res(), { once: true })
      ws.addEventListener('error', () => rej(new Error('ws 连接失败')), { once: true })
    })

    const events: AgentEvent[] = []
    let text = ''
    let runId = ''
    let roundDone = Promise.withResolvers<AgentEvent>()
    const toolNames = new Map<string, string>()

    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(String(e.data))
      if (msg.type === 'hello.err') return roundDone.reject(new Error(`hello 失败: ${msg.message}`))
      if (!msg.seq || !msg.event) return
      const ev = msg.event as AgentEvent
      events.push(ev)
      switch (ev.type) {
        case 'run.started':
          runId = ev.runId
          text = ''
          log(`run.started ${ev.runId}`)
          break
        case 'text.delta':
          text += ev.delta
          break
        case 'tool.started': {
          toolNames.set(ev.toolCallId, ev.toolName)
          if (['workflow', 'subagent', 'define_role'].includes(ev.toolName)) {
            log(`tool.started ${ev.toolName} ${JSON.stringify(ev.args).slice(0, 400)}`)
          }
          break
        }
        case 'tool.finished': {
          const name = toolNames.get(ev.toolCallId)
          if (name && ['workflow', 'subagent', 'define_role'].includes(name)) {
            log(
              `tool.finished ${name} ${ev.status} ${String(ev.outcome?.message ?? '').slice(0, 300)}`,
            )
          }
          break
        }
        case 'team.member':
          log(
            `node ${ev.nodeId} → ${ev.state.phase}${ev.state.subagentId ? ` (${ev.state.subagentId})` : ''}${ev.state.error ? `：${ev.state.error}` : ''}`,
          )
          break
        case 'run.finished':
        case 'run.error':
          log(`${ev.type} ${JSON.stringify(ev).slice(0, 300)}`)
          roundDone.resolve(ev)
          break
        default:
          break
      }
    })

    ws.send(
      JSON.stringify({
        type: 'hello',
        token: h.token,
        origin: 'desktop',
        subscribe: [conversationId],
      }),
    )
    await Bun.sleep(300)

    const waitFor = async <T extends AgentEvent>(
      label: string,
      pick: (ev: AgentEvent) => ev is T,
      count: number,
      ms: number,
    ): Promise<T[]> => {
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        const hits = events.filter(pick)
        if (hits.length >= count) return hits
        await Bun.sleep(500)
      }
      throw new Error(`等 ${label} 超时（${ms / 1000}s）`)
    }
    const started =
      (name: string) =>
      (ev: AgentEvent): ev is Started =>
        ev.type === 'tool.started' && ev.toolName === name
    const finishedOf = (name: string) =>
      events.filter(
        (ev): ev is Finished =>
          ev.type === 'tool.finished' && toolNames.get(ev.toolCallId) === name,
      )
    const working = (ev: AgentEvent): ev is Member =>
      ev.type === 'team.member' && ev.state.phase === 'working' && !!ev.state.subagentId

    const send = (content: string) => {
      roundDone = Promise.withResolvers<AgentEvent>()
      ws.send(
        JSON.stringify({
          type: 'message.send',
          clientRequestId: crypto.randomUUID(),
          conversationId,
          content,
        }),
      )
    }
    const endOfRound = (ms: number) =>
      Promise.race([
        roundDone.promise,
        Bun.sleep(ms).then(() => {
          throw new Error(`这一轮 ${ms / 1000}s 没有收尾`)
        }),
      ])

    // ── 首派 ──
    process.stdout.write('\n首派：用户原话\n')
    send(INSTRUCTION)
    const [first] = await waitFor(
      'workflow 首派',
      started('workflow'),
      1,
      FIRST_DISPATCH_TIMEOUT_MS,
    )
    const args = first!.args as {
      goal?: string
      nodes?: { id: string; kind?: string; name?: string; model?: string; provider?: string }[]
      maxConcurrent?: number
    }
    const agentNodes = (args.nodes ?? []).filter((n) => n.kind !== 'checkpoint')
    check('没有调用 define_role', events.filter(started('define_role')).length === 0)
    check('没有单独用 subagent 派', events.filter(started('subagent')).length === 0)
    check(`一张图四个 agent 节点（${agentNodes.length}）`, agentNodes.length === 4, agentNodes)
    check(
      '四个节点都是临时子 agent（kind=temp，带 name）',
      agentNodes.every((n) => n.kind === 'temp' && !!n.name),
      agentNodes.map((n) => [n.kind, n.name]),
    )
    const models = agentNodes.map((n) => n.model ?? '')
    check(
      '四个模型各归各，正是用户点名的四个',
      EXPECTED_MODELS.every((e) => models.some((m) => e.matches(m))) && new Set(models).size === 4,
      models,
    )
    check(
      '每个 model 都配了 provider',
      agentNodes.every((n) => !n.model || !!n.provider),
      agentNodes.map((n) => [n.provider, n.model]),
    )
    check('并发够四个同时跑', (args.maxConcurrent ?? 4) >= 4, args.maxConcurrent)

    const live = await waitFor('四个节点 working', working, 4, 3 * 60_000)
    const byNode = new Map(live.map((m) => [m.nodeId, m.state.subagentId as string]))
    check(`四个节点各有子 agent（${byNode.size}）`, byNode.size >= 4, [...byNode])
    const kids = listChildConversations(store, conversationId)
    check(
      `账本里四条子会话（${kids.length}）`,
      kids.length === 4,
      kids.map((c) => c.title),
    )
    check(
      '子会话都是临时种类、父会话是它',
      kids.every((c) => c.source === 'temp' && c.parentConversationId === conversationId),
    )
    check(
      '子会话的模型与节点上写的一致',
      agentNodes.every((n) => {
        const id = byNode.get(n.id)
        const c = id ? getConversation(store, id as ConversationId) : null
        return !!c && (!n.model || c.model === n.model)
      }),
      kids.map((c) => [c.title, c.provider, c.model]),
    )
    const spread =
      Math.max(...kids.map((c) => c.createdAt)) - Math.min(...kids.map((c) => c.createdAt))
    check(`四条子会话在 10 秒内先后建起（相差 ${spread}ms）`, spread < 10_000)
    const stepOf = () =>
      listRuns(store, conversationId)
        .flatMap((r) => listSteps(store, r.id))
        .find((s) => s.id === first!.stepId)
    const persisted = stepOf()?.payload
    const nodesOnStep =
      persisted?.kind === 'tool_call' || persisted?.kind === 'tool_result'
        ? persisted.nodes
        : undefined
    check(
      '四格状态已经落在这条 step 上（刷新即可重画）',
      !!nodesOnStep &&
        agentNodes.every(
          (n) => nodesOnStep[n.id]?.phase === 'working' && !!nodesOnStep[n.id]?.subagentId,
        ),
      nodesOnStep,
    )

    const firstWorkflowId = first!.stepId
    if (INTERRUPT) {
      // ── 中断 ──
      log(`四个都在跑，${INTERRUPT_AFTER_MS / 1000}s 后中断`)
      await Bun.sleep(INTERRUPT_AFTER_MS)
      process.stdout.write('\n中断：run.interrupt\n')
      ws.send(JSON.stringify({ type: 'run.interrupt', runId }))
      const ended = await endOfRound(3 * 60_000)
      check(
        '这一轮以中断收尾',
        ended.type === 'run.finished' && ended.stopReason === 'user_interrupt',
        ended,
      )
      const after = stepOf()?.payload
      const afterNodes = after?.kind === 'tool_result' ? after.nodes : undefined
      check(
        '四格都落成终态（中断 / 失败），没有一格停在进行中',
        !!afterNodes &&
          agentNodes.every((n) =>
            ['interrupted', 'failed'].includes(afterNodes[n.id]?.phase ?? ''),
          ),
        afterNodes,
      )
      const listed = (await (
        await fetch(`${base}/api/conversations/${conversationId}/subagents`, { headers: auth })
      ).json()) as ConversationSubagentsResponse
      check(
        '子 agent 页列出四个，状态都不是进行中',
        listed.subagents.length === 4 && listed.subagents.every((s) => s.status !== 'running'),
        listed.subagents,
      )
      check(
        '子 agent 页列出这张工作流且已失败',
        listed.workflows.length === 1 && listed.workflows[0]?.phase === 'failed',
        listed.workflows,
      )

      // ── 继续 ──
      process.stdout.write('\n继续：一句「继续」\n')
      send('继续')
      await waitFor('续跑的 workflow 调用', started('workflow'), 2, FIRST_DISPATCH_TIMEOUT_MS)
      const resumeCall = events.filter(started('workflow'))[1]!
      const resumeArgs = resumeCall.args as {
        workflowId?: string
        decision?: string
        revisions?: { nodeId: string }[]
      }
      check(
        '续跑是 revise 同一张工作流，不是另起一张',
        resumeArgs.decision === 'revise' && resumeArgs.workflowId === firstWorkflowId,
        resumeArgs,
      )
      check(
        'revise 覆盖了四个节点',
        new Set((resumeArgs.revisions ?? []).map((r) => r.nodeId)).size === 4,
        resumeArgs.revisions,
      )
      const ended2 = await endOfRound(ROUND_TIMEOUT_MS)
      check(
        '续跑这一轮正常收尾',
        ended2.type === 'run.finished' && ended2.stopReason === 'completed',
        ended2,
      )
      const kidsAfter = listChildConversations(store, conversationId)
      check(`仍是原来四条子会话，没有另起（${kidsAfter.length}）`, kidsAfter.length === 4)
      check(
        '四个子 agent 各自续了第二轮',
        kidsAfter.every((c) => listRuns(store, c.id).length >= 2),
        kidsAfter.map((c) => [c.title, listRuns(store, c.id).length]),
      )
    } else {
      const ended = await endOfRound(ROUND_TIMEOUT_MS)
      check(
        '这一轮正常收尾',
        ended.type === 'run.finished' && ended.stopReason === 'completed',
        ended,
      )
    }

    // ── 验收 ──
    process.stdout.write('\n验收\n')
    const listed = (await (
      await fetch(`${base}/api/conversations/${conversationId}/subagents`, { headers: auth })
    ).json()) as ConversationSubagentsResponse
    check('全程没有 define_role', events.filter(started('define_role')).length === 0)
    check(
      '工作流只有一张，且已完成',
      listed.workflows.length === 1 && listed.workflows[0]?.phase === 'completed',
      listed.workflows.map((w) => [w.workflowId, w.phase, w.checkpointId]),
    )
    check(
      '四格最终都是完成',
      listed.workflows[0]?.nodes.every((n) => n.phase === 'done') ?? false,
      listed.workflows[0]?.nodes,
    )
    const calls = finishedOf('workflow')
    // 有节点失败的那一轮回 failure 是对的：回执带着失败原因交回检查点。要挡的是图不合法那种错。
    check(
      `workflow 调用都返回了回执或完成（${calls.length} 次）`,
      calls.length > 0 &&
        calls.every((c) => c.status === 'success' || /回执/.test(String(c.outcome?.message ?? ''))),
      calls.map((c) => [c.status, c.outcome?.message]),
    )
    check('父会话给出了验收与横向对比', text.length > 200, text.slice(0, 200))
    process.stdout.write(`\n父会话最后一段：\n${text.slice(0, 2000)}\n`)
    process.stdout.write(
      `\n会话 ${conversationId}；子会话：${listed.subagents.map((s) => `${s.name}=${s.id}`).join('，')}\n`,
    )

    ws.close()
  } finally {
    h.stop()
    store.close()
  }
  return failures
}

const n = await main()
process.stdout.write(`\n${n === 0 ? '全部通过' : `${n} 项未通过`}\n`)
process.exit(n === 0 ? 0 : 1)
