#!/usr/bin/env bun
/**
 * 外部 CLI 回执的端到端冒烟：让真实模型把任务派发给本机的 claude / codex，
 * 核对返回的回执，再追问一次。
 *
 * 验证单元测试无法覆盖的部分：契约确实随任务发出、会话 id 确实可以识别、
 * 追问时外部 CLI 保留上一轮的执行记录（而不是重新读取文件）。
 *
 *   bun run scripts/smoke-cli-receipt.ts
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentEvent, EventEnvelope } from '@qywork/core'
import { loadConfig } from '@qywork/runtime'
import { serve } from '@qywork/server'
import { Store } from '@qywork/store'

const ROOT = join(import.meta.dir, '..', '.tmp', 'smoke-ws')
const WS_GIT = join(ROOT, 'cli-receipt')
/** 非 git 仓库的工作区：派发任务与追问都不应受影响。 */
const WS_BARE = join(ROOT, 'cli-receipt-bare')
/** 账本放在工作区外：它持续写入，放在工作区内只会给本次运行增加噪声。 */
const DB = join(ROOT, 'cli-receipt-db', 'ledger.sqlite3')

/** 一轮中需要等待一个外部 agent 从头执行完毕，比本地 agent 的一轮慢得多。 */
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
  session?: string
  nodes?: Receipt[]
}

/** 已连接的会话：可发起一轮，并按工具名取回该轮的回执。 */
interface Session {
  turn(content: string): Promise<void>
  receiptOf(tool: string): Receipt | null
  close(): void
}

async function connect(base: string, token: string, title: string): Promise<Session> {
  const auth = { authorization: `Bearer ${token}` }
  const created = (await (
    await fetch(`${base}/api/conversations`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    })
  ).json()) as { conversation?: { id?: string } }
  const conversationId = created.conversation?.id ?? ''

  const ws = new WebSocket(`${base.replace('http', 'ws')}/stream?token=${token}&origin=desktop`)
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
  ws.send(JSON.stringify({ type: 'hello', token, origin: 'desktop', subscribe: [conversationId] }))
  await Bun.sleep(300)

  return {
    close: () => ws.close(),
    async turn(content: string) {
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
    },
    // 工具名只在 `tool.started` 上，终局事件只有 `toolCallId`，因此按 `toolCallId` 关联。
    receiptOf(tool: string) {
      const named = new Map<string, string>()
      for (const f of frames) {
        const e = f.event
        if (e.type === 'tool.started') named.set(e.toolCallId, e.toolName)
      }
      const hit = frames
        .map((f) => f.event)
        .filter((e): e is ToolFinished => e.type === 'tool.finished')
        .reverse()
        .find((e) => named.get(e.toolCallId) === tool)
      return (hit?.outcome?.data as Receipt | undefined) ?? null
    },
  }
}

async function main(): Promise<number> {
  await rm(ROOT, { recursive: true, force: true })
  await mkdir(WS_GIT, { recursive: true })
  await mkdir(WS_BARE, { recursive: true })
  await mkdir(join(DB, '..'), { recursive: true })
  await writeFile(join(WS_GIT, 'README.md'), '# 演示\n\n这个目录用于验证外部 CLI 的回执。\n')
  await writeFile(join(WS_BARE, 'README.md'), '# 没有 git 的工作区\n')

  const store = new Store({ path: DB })
  const config = await loadConfig()
  process.stdout.write(`\n父会话模型 ${config.active?.model ?? '（未配置）'}\n\n`)

  {
    const h = serve({ store, config, workspaceRoot: WS_GIT, port: 0, host: '127.0.0.1' })
    const s = await connect(`http://127.0.0.1:${h.port}`, h.token, '外部 CLI 回执')
    try {
      process.stdout.write('  … 第一轮：单项派发给 cli:claude\n')
      await s.turn(
        '用 subagent 把下面这件事整个交给 cli:claude，**你自己一个文件都不要碰、也不要用任何文件工具**：\n' +
          '在这个目录里新建 report.md，里面写一行「已阅」；再把 README.md 末尾追加一行「已阅」。\n' +
          '它做完之后，把它的回执原样转述给我。',
      )
      const solo = s.receiptOf('subagent')
      check(
        '单项派发：外部 CLI 的回执包含在产出中',
        typeof solo?.output === 'string' && solo.output.includes('回执'),
        solo?.output?.slice(0, 200),
      )
      check('单项派发：识别出会话 id', !!solo?.session, solo)
      check(
        '单项派发：文件已写入',
        (await readFile(join(WS_GIT, 'report.md'), 'utf8').catch(() => '')).includes('已阅'),
      )

      process.stdout.write('  … 追问（同一条 CLI 会话）\n')
      await s.turn(
        `再用 subagent 接着问 cli:claude 一句：resume 参数填 ${solo?.session ?? ''}，` +
          'task 写「你刚才具体改了哪些文件？只列文件名，别的不要说」。把它的回答原样给我。',
      )
      const again = s.receiptOf('subagent')
      // 只有保留上一轮记录才能答出这两个文件名，新建的会话无法答出。
      check(
        '追问：外部 CLI 记得上一轮修改的两个文件',
        (again?.output ?? '').includes('report.md') && (again?.output ?? '').includes('README.md'),
        again?.output?.slice(0, 300),
      )
      check('追问：仍为同一条会话', !!again?.session && again.session === solo?.session, {
        first: solo?.session,
        again: again?.session,
      })

      process.stdout.write('  … 第二轮：工作流中一个节点派发给 cli:codex\n')
      await s.turn(
        '用 workflow 画一张只有一个节点的图，节点 agent 填 cli:codex，任务是：' +
          '把 report.md 的内容改成两行——第一行保持「已阅」，第二行写「codex 到此一游」。' +
          '**你自己不要动手**。跑完把那个节点的回执原样给我。',
      )
      const node = s.receiptOf('workflow')?.nodes?.[0]
      check('工作流节点：已返回产出', !!node?.output, node)
      check(
        '工作流节点：report.md 已变为两行',
        (await readFile(join(WS_GIT, 'report.md'), 'utf8').catch(() => '')).includes('codex'),
      )

      process.stdout.write('  … 第三轮：单项派发给 cli:grok，再追问一次\n')
      await s.turn(
        '用 subagent 把这件事整个交给 cli:grok，**你自己一个文件都不要碰**：' +
          '在这个目录里新建 grok.md，写一行「已阅」。做完把它的回执转述给我。',
      )
      const gk = s.receiptOf('subagent')
      check('grok：已返回产出（不是原始 JSON）', !!gk?.output && !gk.output.startsWith('{'), gk)
      check('grok：识别出会话 id', !!gk?.session, gk)
      check(
        'grok：文件已写入',
        (await readFile(join(WS_GIT, 'grok.md'), 'utf8').catch(() => '')).includes('已阅'),
      )
      await s.turn(
        `再用 subagent 接着问 cli:grok：resume 填 ${gk?.session ?? ''}，` +
          'task 写「你刚才新建了哪个文件？只说文件名」。把回答原样给我。',
      )
      const gkAgain = s.receiptOf('subagent')
      check(
        'grok：追问时记得上一轮',
        (gkAgain?.output ?? '').includes('grok.md'),
        gkAgain?.output?.slice(0, 200),
      )
    } finally {
      s.close()
      h.stop()
    }
  }

  {
    const h = serve({ store, config, workspaceRoot: WS_BARE, port: 0, host: '127.0.0.1' })
    const s = await connect(`http://127.0.0.1:${h.port}`, h.token, '没有 git 的工作区')
    try {
      process.stdout.write('  … 第四轮：非 git 工作区，单项派发给 cli:claude\n')
      await s.turn(
        '用 subagent 把这件事整个交给 cli:claude，**你自己一个文件都不要碰**：' +
          '在这个目录里新建 hello.txt，写一行「你好」。做完把它的回执转述给我。',
      )
      const bare = s.receiptOf('subagent')
      check('非 git：仍可派发', !!bare?.output, bare)
      check('非 git：仍可识别会话 id', !!bare?.session, bare)
      const wrote = await readFile(join(WS_BARE, 'hello.txt'), 'utf8').catch(() => '')
      check('非 git：文件已写入', wrote.includes('你好'), wrote)
    } finally {
      s.close()
      h.stop()
    }
  }

  store.close()
  process.stdout.write(failures === 0 ? `\n全部通过。库 ${DB}\n` : `\n${failures} 条未通过\n`)
  return failures === 0 ? 0 : 1
}

process.exit(await main())
