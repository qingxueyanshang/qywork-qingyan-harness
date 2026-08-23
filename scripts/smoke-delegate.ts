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
    const done = Promise.withResolvers<void>()

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

    process.stdout.write('  … 正在跑一轮真实 agent\n')
    ws.send(
      JSON.stringify({
        type: 'message.send',
        clientRequestId: crypto.randomUUID(),
        conversationId,
        content:
          '这个目录下有 a.txt / b.txt / c.txt / d.txt，每个文件里有一个编号。你自己一个文件都不要读，全部交给子 agent：\n' +
          '1. 先用 subagent 起一个临时子 agent（不要指定 agent），让它读 a.txt 并报回编号；\n' +
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

    ws.close()
  } finally {
    h.stop()
    store.close()
  }

  process.stdout.write(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}\n`)
  return failures === 0 ? 0 : 1
}

process.exit(await main())
