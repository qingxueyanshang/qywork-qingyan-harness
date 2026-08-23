#!/usr/bin/env bun
/**
 * 临时子 agent 的端到端冒烟：起服务 → 让真实模型自己派活 → 核对派出去的那几条。
 *
 * 验的是单元测试验不到的那一段：模型**不先定义角色**就能铺开子 agent，
 * 每个子 agent 真的起了一条独立会话，产出真的回到了父会话。
 *
 *   bun run scripts/smoke-delegate.ts
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentEvent, ConversationId, EventEnvelope } from '@qywork/core'
import { loadConfig } from '@qywork/runtime'
import { serve } from '@qywork/server'
import { getConversation, Store } from '@qywork/store'

const WS_DIR = join(import.meta.dir, '..', '.smoke-ws', 'delegate')
const DB = join(WS_DIR, 'delegate.sqlite3')

/** 一父四子五条会话串下来，比单轮慢得多；短了会把 provider 的抖动记成 bug。 */
const RUN_TIMEOUT_MS = 480_000

/** 三个子 agent 各读一个文件，报回来的就是这三个串。 */
const TOKENS: Record<string, string> = { b: 'ZK-4417', c: 'QP-8823', d: 'MT-9051' }
const SOLO = 'RX-2264'

let failures = 0
function check(label: string, ok: boolean, detail?: unknown): void {
  process.stdout.write(`${ok ? '  ✓' : '  ✗'} ${label}\n`)
  if (!ok) {
    failures++
    if (detail !== undefined)
      process.stdout.write(`      ${JSON.stringify(detail).slice(0, 600)}\n`)
  }
}

type Member = Extract<AgentEvent, { type: 'team.member' }>
type ToolFinished = Extract<AgentEvent, { type: 'tool.finished' }>

async function main(): Promise<number> {
  await rm(WS_DIR, { recursive: true, force: true })
  await mkdir(WS_DIR, { recursive: true })
  await writeFile(join(WS_DIR, 'a.txt'), `编号：${SOLO}\n`, 'utf8')
  for (const [name, token] of Object.entries(TOKENS)) {
    await writeFile(join(WS_DIR, `${name}.txt`), `编号：${token}\n`, 'utf8')
  }

  const store = new Store({ path: DB })
  const config = await loadConfig()
  const h = serve({ store, config, workspaceRoot: WS_DIR, port: 0, host: '127.0.0.1' })
  const base = `http://127.0.0.1:${h.port}`
  const auth = { authorization: `Bearer ${h.token}` }
  process.stdout.write(`\n服务已起：${base}（模型 ${config.active.model}）\n\n`)

  try {
    const created = (await (
      await fetch(`${base}/api/conversations`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ title: '派活冒烟' }),
      })
    ).json()) as { conversation?: { id?: string } }
    const conversationId = created.conversation?.id ?? ''

    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/stream?token=${h.token}&origin=desktop`)
    await new Promise<void>((res, rej) => {
      ws.addEventListener('open', () => res(), { once: true })
      ws.addEventListener('error', () => rej(new Error('ws 连接失败')), { once: true })
    })

    const frames: EventEnvelope<AgentEvent>[] = []
    const members: Member[] = []
    let permissionAsks = 0
    let text = ''
    // 这条脚本要跑两轮（临时子 agent 一轮、外部 CLI 一轮），所以「等这一轮跑完」
    // 是个可以重新拿一次的东西，不是一个一次性的 promise。
    let done = Promise.withResolvers<void>()

    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(String(e.data))
      if (msg.type === 'hello.err') return done.reject(new Error(`hello 失败: ${msg.message}`))
      if (!msg.seq || !msg.event) return
      frames.push(msg)
      const ev = msg.event as AgentEvent
      if (ev.type === 'permission.request') {
        permissionAsks++
        ws.send(
          JSON.stringify({
            type: 'permission.resolve',
            requestId: ev.requestId,
            granted: true,
            scopeId: 'session',
          }),
        )
        return
      }
      if (ev.type === 'team.member') members.push(ev)
      else if (ev.type === 'text.delta') text += ev.delta
      else if (ev.type === 'run.finished') done.resolve()
      else if (ev.type === 'run.error') done.resolve()
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

    /*
     * 先把父会话切到另一个模型：临时子 agent 该跟着**这一个**跑，而不是配置默认那个。
     * 只配了一个模型的机器上验不了这条，如实说一句跳过，不装作验过。
     */
    const catalog = (await (await fetch(`${base}/api/models`, { headers: auth })).json()) as {
      providers: { name: string; models: { id: string }[] }[]
    }
    // 切模型要**成对**给：只给模型名会被回执拒掉（`commands.ts` 先查接口在不在配置里），
    // 而拒了以后这一轮照样跑默认模型，看起来像「继承没生效」。
    const alt = catalog.providers
      .flatMap((p) => p.models.map((m) => ({ provider: p.name, model: m.id })))
      .find((r) => r.model !== config.active.model)
    if (alt) {
      ws.send(JSON.stringify({ type: 'conversation.setModel', conversationId, ...alt }))
      await Bun.sleep(300)
      check(
        `父会话切到 ${alt.model}`,
        getConversation(store, conversationId as ConversationId)?.model === alt.model,
      )
    } else {
      process.stdout.write('  … 只配了一个模型，「子 agent 跟父会话」这条跳过未验\n')
    }

    process.stdout.write('  … 正在跑一轮真实 agent\n')
    ws.send(
      JSON.stringify({
        type: 'message.send',
        clientRequestId: crypto.randomUUID(),
        conversationId,
        content:
          '这个目录下有 a.txt / b.txt / c.txt / d.txt，每个文件里有一个编号。你自己一个文件都不要读，全部交给子 agent：\n' +
          `1. 先用 subagent 起一个临时子 agent（不要指定 agent），让它读 a.txt 并报回编号，这一个点名用 ${config.active.model} 模型；\n` +
          '2. 再用 workflow 起三个并行的临时子 agent（节点都不要写 agent），分别读 b.txt、c.txt、d.txt 并各自报回编号；\n' +
          '最后把四个编号写成一行给我。',
      }),
    )

    const timer = setTimeout(
      () =>
        done.reject(
          new Error(
            `超时。事件计数：${JSON.stringify(
              frames.reduce<Record<string, number>>((a, f) => {
                a[f.event.type] = (a[f.event.type] ?? 0) + 1
                return a
              }, {}),
            )}`,
          ),
        ),
      RUN_TIMEOUT_MS,
    )
    await done.promise
    clearTimeout(timer)

    const errored = frames.find((f) => f.event.type === 'run.error')
    check('本轮没有 provider 错误', errored === undefined, errored?.event)

    // 工具名只在 `tool.started` 上，终局事件只有 `toolCallId`——按它认回去。
    const names = new Map<string, string>()
    for (const f of frames) {
      if (f.event.type === 'tool.started') names.set(f.event.toolCallId, f.event.toolName)
    }
    const finishedTools = frames
      .map((f) => f.event)
      .filter((ev): ev is ToolFinished => ev.type === 'tool.finished')
    const named = (name: string) => finishedTools.filter((t) => names.get(t.toolCallId) === name)
    const subagentCalls = named('subagent')
    const workflowCalls = named('workflow')

    process.stdout.write('\n不指定 agent 就能派\n')
    check('模型没先定义角色', !(await Bun.file(join(WS_DIR, '.qy', 'team.json')).exists()))
    check(
      'subagent 派出去了',
      subagentCalls.length > 0,
      finishedTools.map((t) => names.get(t.toolCallId)),
    )
    check(
      'subagent 成了，且回执写的是临时子 agent',
      subagentCalls.some(
        (t) =>
          t.outcome?.status === 'success' &&
          String(t.outcome?.message ?? '').includes('临时子 agent'),
      ),
      subagentCalls.map((t) => t.outcome?.message),
    )

    const soloChild = (
      subagentCalls.at(-1)?.outcome?.data as { conversationId?: string } | undefined
    )?.conversationId
    check('单发把子会话 id 带回来了', typeof soloChild === 'string' && soloChild.length > 0)
    if (soloChild) {
      // 点名的模型要盖过父会话那一对。这一条与下面「跟着父会话跑」是同一件事的两面：
      // 两条都在才说明优先级真的成立，而不是两处碰巧取到同一个值。
      check(
        `点名的模型压过父会话（${config.active.model}）`,
        getConversation(store, soloChild as ConversationId)?.model === config.active.model,
        getConversation(store, soloChild as ConversationId)?.model,
      )
    }

    process.stdout.write('\n一张图铺三个\n')
    check('workflow 派出去了', workflowCalls.length > 0)
    const graph = workflowCalls.at(-1)
    const nodes =
      (
        graph?.outcome?.data as
          | { nodes?: { nodeId: string; agent: string; status: string; conversationId?: string }[] }
          | undefined
      )?.nodes ?? []
    check(
      '图跑完了且节点全 done',
      graph?.outcome?.status === 'success' &&
        nodes.length >= 3 &&
        nodes.every((n) => n.status === 'done'),
      nodes,
    )
    check(
      '节点都落在临时子 agent 上',
      nodes.length > 0 && nodes.every((n) => n.agent === 'ad-hoc'),
      nodes.map((n) => n.agent),
    )

    process.stdout.write('\n进度与子会话\n')
    const adHoc = members.filter((m) => m.roleName === '临时子 agent')
    const ids = new Set(adHoc.map((m) => m.memberId))
    check(`临时子 agent 的进度事件到齐（${ids.size} 个成员）`, ids.size >= 3, [...ids])
    check('进度都走内置后端', adHoc.length > 0 && adHoc.every((m) => m.backend === 'builtin'), [
      ...new Set(adHoc.map((m) => m.backend)),
    ])
    check(
      '进度都带 stepId（图卡按它认领）',
      adHoc.length > 0 && adHoc.every((m) => typeof m.stepId === 'string' && m.stepId.length > 0),
    )

    const firstDone = adHoc.findIndex((m) => m.phase === 'done')
    const spawnedBeforeFirstDone = adHoc
      .slice(0, firstDone === -1 ? adHoc.length : firstDone)
      .filter((m) => m.phase === 'spawned').length
    check(
      `确实并行：第一个做完之前已经起了 ${spawnedBeforeFirstDone} 个`,
      spawnedBeforeFirstDone >= 3,
      adHoc.map((m) => `${m.memberId}:${m.phase}`),
    )

    const childIds = [
      ...new Set(
        adHoc
          .filter((m) => m.childConversationId)
          .map((m) => m.childConversationId as ConversationId),
      ),
    ]
    check(`每个子 agent 一条独立会话（${childIds.length} 条）`, childIds.length >= 3, childIds)
    check(
      '子会话确实落库',
      childIds.length > 0 && childIds.every((id) => getConversation(store, id) !== null),
    )
    if (alt) {
      check(
        `子 agent 跟着父会话的模型跑（${alt.model}）`,
        childIds.length > 0 &&
          childIds.every((id) => getConversation(store, id)?.model === alt.model),
        childIds.map((id) => getConversation(store, id)?.model),
      )
    }
    const listed = (await (await fetch(`${base}/api/conversations`, { headers: auth })).json()) as {
      conversations: { id: string }[]
    }
    check(
      '子会话不混进会话列表',
      childIds.every((id) => !listed.conversations.some((c) => c.id === id)),
      listed.conversations.map((c) => c.id),
    )

    process.stdout.write('\n产出真的回来了\n')
    const expected: [string, string][] = [['a', SOLO], ...Object.entries(TOKENS)]
    for (const [name, token] of expected) {
      check(
        `${name}.txt 的编号出现在最终回答里（${token}）`,
        text.includes(token),
        text.slice(-300),
      )
    }
    check('全程没有弹授权', permissionAsks === 0, permissionAsks)

    // ── 第二轮：派给本机装着的外部 CLI ──
    //
    // 这条路与内置子 agent 完全不同：另起一个进程、它自己的凭证、它自己的输出格式，
    // 而输出格式恰恰是那张厂商表最容易过期的地方（实测 codex 就过期了一次）。
    const clis = (await (await fetch(`${base}/api/team/cli`, { headers: auth })).json()) as {
      agents?: { id: string; connected?: boolean }[]
    }
    const target = clis.agents?.find((c) => c.connected)?.id ?? 'claude'
    process.stdout.write(`\n外部 CLI（cli:${target}）\n`)

    const mark = frames.length
    done = Promise.withResolvers<void>()
    ws.send(
      JSON.stringify({
        type: 'message.send',
        clientRequestId: crypto.randomUUID(),
        conversationId,
        content:
          `派两件事，都交给外部 CLI，你自己不要动手：\n` +
          `1. 用 subagent，agent 填 cli:${target}，任务是「只回答两个字：收到」；\n` +
          `2. 用 workflow 画一张两个节点的图，两个并行：节点 ping 的 agent 填 cli:${target}，` +
          `任务是「只回答四个字母：PING」；节点 pong 不指定 agent，任务是「只回答四个字母：PONG」。\n` +
          `最后原样告诉我它们各自回了什么。`,
      }),
    )
    const timer2 = setTimeout(() => done.reject(new Error('第二轮超时')), RUN_TIMEOUT_MS)
    await done.promise
    clearTimeout(timer2)

    const round2 = frames.slice(mark)
    for (const f of round2) {
      if (f.event.type === 'tool.started') names.set(f.event.toolCallId, f.event.toolName)
    }
    const tools2 = round2
      .map((f) => f.event)
      .filter((ev): ev is ToolFinished => ev.type === 'tool.finished')
    const toCli = tools2.filter((t) => names.get(t.toolCallId) === 'subagent')
    check('subagent 派给了外部 CLI', toCli.length > 0)
    const cliOut = String(
      (toCli.at(-1)?.outcome?.data as { output?: string } | undefined)?.output ?? '',
    )
    check(
      `外部 CLI 跑成了（${toCli.at(-1)?.outcome?.status}）`,
      toCli.at(-1)?.outcome?.status === 'success',
      toCli.at(-1)?.outcome?.message,
    )
    /*
     * 产出必须是**那句话**，不是它的 JSONL 原始流。
     *
     * 复现的失败形状：厂商表里的结果字段过期时 `extract` 一行都取不到，
     * 回退成整段 stdout——父会话拿到的是一坨 `{"type":"thread.started"…}`，
     * 而模型会把那坨当成任务产出。长度上限就是这条的判据。
     */
    check(
      '产出是答案本身，不是 JSONL 原始流',
      cliOut.length > 0 && cliOut.length < 200 && !cliOut.includes('"type"'),
      cliOut.slice(0, 200),
    )

    const graph2 = tools2.filter((t) => names.get(t.toolCallId) === 'workflow').at(-1)
    const nodes2 =
      (
        graph2?.outcome?.data as
          | { nodes?: { nodeId: string; agent: string; status: string; conversationId?: string }[] }
          | undefined
      )?.nodes ?? []
    check(
      '图里 CLI 节点与临时子 agent 混着跑通',
      nodes2.length >= 2 && nodes2.every((n) => n.status === 'done'),
      nodes2,
    )
    const cliNode = nodes2.find((n) => n.agent.startsWith('cli:'))
    check(
      '图里确实有一个 CLI 节点',
      !!cliNode,
      nodes2.map((n) => n.agent),
    )
    // 外部 CLI 是本机另一个进程，没有子会话——这个字段缺席是对的，
    // 前端据此把那种节点画成点不开。
    check('CLI 节点不带子会话 id', cliNode ? cliNode.conversationId === undefined : false)
    const cliMembers = members.filter((m) => m.backend !== 'builtin')
    check('CLI 节点的进度走的是外部后端', cliMembers.length > 0, [
      ...new Set(members.map((m) => m.backend)),
    ])

    ws.close()
  } finally {
    h.stop()
    store.close()
  }

  process.stdout.write(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}\n`)
  return failures === 0 ? 0 : 1
}

process.exit(await main())
