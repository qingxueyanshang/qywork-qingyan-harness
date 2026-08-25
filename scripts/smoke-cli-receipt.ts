#!/usr/bin/env bun
/**
 * 外部 CLI 回执的端到端冒烟：让真实模型把活派给本机的 claude / codex，
 * 核对回来的那份回执——它自己报的那段，和这一侧量出来的改动清单。
 *
 * 验的是单元测试验不到的一段：契约真的随任务发出去了、清单真的是量出来的
 * （**跑之前就脏的那些不算在它头上**）、单发与图节点两条路带回来的形状一致，
 * 以及**工作区不是 git 仓库时那一支**——它必须说「量不了」，不能长得像「没有改动」。
 *
 *   bun run scripts/smoke-cli-receipt.ts
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentEvent, EventEnvelope } from '@qywork/core'
import { loadConfig } from '@qywork/runtime'
import { serve } from '@qywork/server'
import { Store } from '@qywork/store'

const ROOT = join(import.meta.dir, '..', '.smoke-ws')
/** 有 git 的那个工作区：量得出清单。 */
const WS_GIT = join(ROOT, 'cli-receipt')
/** 没有 git 的那个：量不了，回执要如实说。 */
const WS_BARE = join(ROOT, 'cli-receipt-bare')
/**
 * 账本必须放在工作区**外面**。
 *
 * 放进去的代价实测付过：sqlite 的 WAL/SHM 一直在动，而清单量的是整个工作区，
 * 于是那三个文件出现在「CLI 改了什么」里——这一条同时说明了这份清单的边界，
 * 它认的是工作区在这段时间里变了什么，不是「这个进程改了什么」。
 */
const DB = join(ROOT, 'cli-receipt-db', 'ledger.sqlite3')

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

/** 一条连上去的会话：能发一轮、能按工具名把这一轮的回执取回来。 */
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
    // 工具名只在 `tool.started` 上，终局事件只有 `toolCallId`——按它认回去。
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

async function gitWorkspace(): Promise<void> {
  await writeFile(join(WS_GIT, 'README.md'), '# 演示\n\n这个仓库用于验证外部 CLI 的回执。\n')
  await writeFile(join(WS_GIT, 'notes.md'), '第一行\n')
  const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: WS_GIT })
  git('init', '-q', '-b', 'main', '.')
  git('config', 'user.email', 'demo@qywork.dev')
  git('config', 'user.name', 'qywork')
  git('add', '-A')
  git('commit', '-qm', 'init')
  // 跑之前就脏一个文件：它是用户自己改到一半的那种，**绝不能出现在 CLI 的清单里**。
  await writeFile(join(WS_GIT, 'notes.md'), '第一行\n用户自己写的第二行\n')
}

async function main(): Promise<number> {
  await rm(ROOT, { recursive: true, force: true })
  await mkdir(WS_GIT, { recursive: true })
  await mkdir(WS_BARE, { recursive: true })
  await mkdir(join(DB, '..'), { recursive: true })
  await gitWorkspace()
  await writeFile(join(WS_BARE, 'README.md'), '# 没有 git 的工作区\n')

  const store = new Store({ path: DB })
  const config = await loadConfig()
  process.stdout.write(`\n父会话模型 ${config.active.model}\n\n`)

  // ── 有 git 的工作区：清单量得出来 ──
  {
    const h = serve({ store, config, workspaceRoot: WS_GIT, port: 0, host: '127.0.0.1' })
    const s = await connect(`http://127.0.0.1:${h.port}`, h.token, '外部 CLI 回执')
    try {
      process.stdout.write('  … 第一轮：单发给 cli:claude\n')
      await s.turn(
        '用 subagent 把下面这件事整个交给 cli:claude，**你自己一个文件都不要碰、也不要用任何文件工具**：\n' +
          '在这个目录里新建 report.md，里面写一行「已阅」；再把 README.md 末尾追加一行「已阅」。\n' +
          '它做完之后，把它的回执原样转述给我，另外说一句这次工具回执里量到几个文件。',
      )
      const solo = s.receiptOf('subagent')
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
      await s.turn(
        '用 workflow 画一张只有一个节点的图，节点 agent 填 cli:codex，任务是：' +
          '把 report.md 的内容改成两行——第一行保持「已阅」，第二行写「codex 到此一游」。' +
          '**你自己不要动手**。跑完把那个节点的回执原样给我。',
      )
      const node = s.receiptOf('workflow')?.nodes?.[0]
      check('图节点：回执带着量出来的清单', !!node?.changes, node)
      check(
        '图节点：改到的 report.md 在清单里',
        (node?.changes?.files ?? []).some((f) => f.path === 'report.md'),
        node?.changes,
      )
      check('图节点：形状与单发一致', !!node?.changes && 'total' in node.changes, node?.changes)
    } finally {
      s.close()
      h.stop()
    }
  }

  /*
   * ── 不是 git 仓库的工作区 ──
   *
   * 而且它还嵌在本仓库里、被 `.gitignore` 挡着——这正是借用外层仓库时答错的那个形状：
   * 两次快照完全相同，回执上写「没有改动」，而文件真的写了。量测自带仓库之后它才对。
   */
  {
    const h = serve({ store, config, workspaceRoot: WS_BARE, port: 0, host: '127.0.0.1' })
    const s = await connect(`http://127.0.0.1:${h.port}`, h.token, '没有 git 的工作区')
    try {
      process.stdout.write('  … 第三轮：非 git 工作区，单发给 cli:claude\n')
      await s.turn(
        '用 subagent 把这件事整个交给 cli:claude，**你自己一个文件都不要碰**：' +
          '在这个目录里新建 hello.txt，写一行「你好」。做完把它的回执转述给我。',
      )
      const bare = s.receiptOf('subagent')
      check('非 git：照样量得出清单', !!bare?.changes, bare)
      check('非 git：不是「量不了」', !bare?.changesUnmeasured, bare?.changesUnmeasured)
      check(
        '非 git：新建的 hello.txt 在清单里',
        (bare?.changes?.files ?? []).some((f) => f.path === 'hello.txt'),
        bare?.changes,
      )
      // 清单说改了，文件就得真的在——两份账要能互相对上。
      const wrote = await readFile(join(WS_BARE, 'hello.txt'), 'utf8').catch(() => '')
      check('非 git：文件其实真的写了', wrote.includes('你好'), wrote)
    } finally {
      s.close()
      h.stop()
    }
  }

  store.close()
  process.stdout.write(failures === 0 ? `\n全部通过。库 ${DB}\n` : `\n${failures} 条没过\n`)
  return failures === 0 ? 0 : 1
}

process.exit(await main())
