#!/usr/bin/env bun
/**
 * 外部 CLI 回执的端到端冒烟：让真实模型把活派给本机的 claude / codex，
 * 核对回来的那份回执——它自己报的那段，和这一侧量出来的改动清单。
 *
 * 验的是单元测试验不到的一段：契约真的随任务发出去了、清单真的是量出来的
 * （**跑之前就脏的那些不算在它头上**）、单发与图节点两条路带回来的形状一致。
 *
 *   bun run scripts/smoke-cli-receipt.ts
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentEvent, EventEnvelope } from '@qywork/core'
import { loadConfig } from '@qywork/runtime'
import { serve } from '@qywork/server'
import { Store } from '@qywork/store'

const WS_DIR = join(import.meta.dir, '..', '.smoke-ws', 'cli-receipt')
/**
 * 账本必须放在工作区**外面**。
 *
 * 放进去的代价实测付过：sqlite 的 WAL/SHM 一直在动，而清单量的是整个工作区，
 * 于是那三个文件出现在「CLI 改了什么」里——这一条同时说明了这份清单的边界，
 * 它认的是工作区在这段时间里变了什么，不是「这个进程改了什么」。
 */
const DB = join(import.meta.dir, '..', '.smoke-ws', 'cli-receipt-db', 'ledger.sqlite3')

/** 一轮里要等一个别家的 agent 从头跑完，比自家一轮慢得多。 */
const RUN_TIMEOUT_MS = 600_000

let failures = 0
function check(label: string, ok: boolean, detail?: unknown): void {
  process.stdout.write(`${ok ? '  ✓' : '  ✗'} ${label}\n`)
  if (!ok) {
    failures++
    if (detail !== undefined)
      process.stdout.write(`      ${JSON.stringify(detail).slice(0, 800)}\n`)
  }
}

type ToolFinished = Extract<AgentEvent, { type: 'tool.finished' }>
interface Receipt {
  output?: string
  changes?: { files: { path: string; changeType: string; additions: number }[]; total: number }
  changesUnmeasured?: string
  nodes?: Receipt[]
}

const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: WS_DIR })

async function main(): Promise<number> {
  await rm(WS_DIR, { recursive: true, force: true })
  await rm(join(DB, '..'), { recursive: true, force: true })
  await mkdir(WS_DIR, { recursive: true })
  await mkdir(join(DB, '..'), { recursive: true })
  await writeFile(join(WS_DIR, 'README.md'), '# 演示\n\n这个仓库用于验证外部 CLI 的回执。\n')
  await writeFile(join(WS_DIR, 'notes.md'), '第一行\n')
  git('init', '-q', '-b', 'main', '.')
  git('config', 'user.email', 'demo@qywork.dev')
  git('config', 'user.name', 'qywork')
  git('add', '-A')
  git('commit', '-qm', 'init')

  // 跑之前就脏一个文件：它是用户自己改到一半的那种，**绝不能出现在 CLI 的清单里**。
  await writeFile(join(WS_DIR, 'notes.md'), '第一行\n用户自己写的第二行\n')

  const store = new Store({ path: DB })
  const config = await loadConfig()
  const h = serve({ store, config, workspaceRoot: WS_DIR, port: 0, host: '127.0.0.1' })
  const base = `http://127.0.0.1:${h.port}`
  const auth = { authorization: `Bearer ${h.token}` }
  process.stdout.write(`\n服务已起：${base}（父会话模型 ${config.active.model}）\n\n`)

  try {
    const created = (await (
      await fetch(`${base}/api/conversations`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ title: '外部 CLI 回执' }),
      })
    ).json()) as { conversation?: { id?: string } }
    const conversationId = created.conversation?.id ?? ''

    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/stream?token=${h.token}&origin=desktop`)
    await new Promise<void>((res, rej) => {
      ws.addEventListener('open', () => res(), { once: true })
      ws.addEventListener('error', () => rej(new Error('ws 连接失败')), { once: true })
    })

    const frames: EventEnvelope<AgentEvent>[] = []
    let done = Promise.withResolvers<void>()
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(String(e.data))
      if (msg.type === 'hello.err') return done.reject(new Error(`hello 失败: ${msg.message}`))
      if (!msg.seq || !msg.event) return
      frames.push(msg)
      const ev = msg.event as AgentEvent
      if (ev.type === 'run.finished' || ev.type === 'run.error') done.resolve()
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

    const turn = async (content: string): Promise<void> => {
      done = Promise.withResolvers<void>()
      ws.send(
        JSON.stringify({
          type: 'message.send',
          clientRequestId: crypto.randomUUID(),
          conversationId,
          content,
        }),
      )
      const timer = setTimeout(() => done.reject(new Error('超时')), RUN_TIMEOUT_MS)
      try {
        await done.promise
      } finally {
        clearTimeout(timer)
      }
    }

    const receiptOf = (tool: string): Receipt | null => {
      const f = frames
        .map((x) => x.event)
        .filter((e): e is ToolFinished => e.type === 'tool.finished')
        .reverse()
        .find((e) => (e.outcome?.data as { nodes?: unknown } | undefined) !== undefined || true)
      void f
      const finished = frames
        .map((x) => x.event)
        .filter((e): e is ToolFinished => e.type === 'tool.finished')
      const started = new Map<string, string>()
      for (const x of frames) {
        const e = x.event
        if (e.type === 'tool.started') started.set(e.toolCallId, e.toolName)
      }
      const hit = finished.reverse().find((e) => started.get(e.toolCallId) === tool)
      return (hit?.outcome?.data as Receipt | undefined) ?? null
    }

    process.stdout.write('  … 第一轮：单发给 cli:claude\n')
    await turn(
      '用 subagent 把下面这件事整个交给 cli:claude，**你自己一个文件都不要碰、也不要用任何文件工具**：\n' +
        '在这个目录里新建 report.md，里面写一行「已阅」；再把 README.md 末尾追加一行「已阅」。\n' +
        '它做完之后，你把它回执里「改了哪些文件」那一段原样转述给我。',
    )
    const solo = receiptOf('subagent')
    check('单发：回执带着量出来的清单', !!solo?.changes, solo)
    check('单发：不是「量不了」', !solo?.changesUnmeasured, solo?.changesUnmeasured)
    const paths = (solo?.changes?.files ?? []).map((f) => f.path)
    check('单发：新建的 report.md 在清单里', paths.includes('report.md'), paths)
    check('单发：改过的 README.md 在清单里', paths.includes('README.md'), paths)
    // 这条是整份设计的要害：跑之前用户自己改的那一行，不许记到 CLI 头上。
    check('单发：跑之前就脏的 notes.md 不在清单里', !paths.includes('notes.md'), paths)
    check(
      '单发：它自己那份回执也在产出里',
      typeof solo?.output === 'string' && solo.output.includes('回执'),
      solo?.output?.slice(0, 200),
    )

    process.stdout.write('  … 第二轮：图里一个节点派给 cli:codex\n')
    await turn(
      '用 workflow 画一张只有一个节点的图，节点 agent 填 cli:codex，任务是：' +
        '把 report.md 的内容改成两行——第一行保持「已阅」，第二行写「codex 到此一游」。' +
        '**你自己不要动手**。跑完把那个节点回执里「改了哪些文件」原样给我。',
    )
    const graph = receiptOf('workflow')
    const node = graph?.nodes?.[0]
    check('图节点：回执带着量出来的清单', !!node?.changes, node)
    check(
      '图节点：改到的 report.md 在清单里',
      (node?.changes?.files ?? []).some((f) => f.path === 'report.md'),
      node?.changes,
    )
    check(
      '图节点：形状与单发一致',
      !!node?.changes && 'total' in (node.changes ?? {}),
      node?.changes,
    )

    ws.close()
    process.stdout.write(
      failures === 0 ? `\n全部通过。会话 ${conversationId}\n库 ${DB}\n` : `\n${failures} 条没过\n`,
    )
    return failures === 0 ? 0 : 1
  } finally {
    h.stop()
    store.close()
  }
}

process.exit(await main())
