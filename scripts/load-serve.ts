#!/usr/bin/env bun

/**
 * 固定负载驱动：模拟 Provider + 真实 `qy serve` 子进程，长时间反复触发定时任务与消息轮次，
 * 期间删除会话、重启服务，并按固定间隔采样进程读数与两库的空间读数。
 *
 * 观测一律只读：进程读数走 PowerShell 的 `Win32_Process`，两库读数走只读 SQLite 连接，
 * 业务改动全部经 HTTP / WebSocket。唯一的例外是服务停止期间制造孤儿正文那一步，
 * 它直接用 `Store` 删会话行——启动回收这条路径没有别的入口能构造出前置状态。
 *
 * 产物落 `.tmp/load/`：`samples.csv` 是采样序列，`events.jsonl` 是每次触发/删除/重启的记录，
 * `summary.json` 是收尾汇总。
 *
 *   bun run scripts/load-serve.ts --minutes 125 --payload-kb 2048
 *   bun run scripts/load-serve.ts seed <db> <工作区> <会话数>
 */

import { Database } from 'bun:sqlite'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ConversationId, NodeState } from '@qywork/core'
import {
  appendMessage,
  appendStep,
  createConversation,
  createRun,
  createSchedule,
  deleteConversation,
  finishRun,
  markRunRunning,
  Store,
  upsertWorkspace,
} from '@qywork/store'
import { commandShell } from '@qywork/tools'

const ROOT = join(import.meta.dir, '..')
const BASE = join(ROOT, '.tmp', 'load')

// ───────────────────────── 数据夹具 ─────────────────────────

/**
 * 给前端量测种一份会话历史。
 *
 * 形状与真实运行一致：全部经 `repos` 写入，`fileChanges` 挂在 `tool_result` 的 outcome 上，
 * 子任务是带 `parentConversationId` 的子会话——变更页与运行面板读的正是这两处。
 */
function seed(dbPath: string, workspaceRoot: string, count: number): void {
  const store = new Store({ path: dbPath })
  const ws = upsertWorkspace(store, workspaceRoot, '负载')
  const ref = { provider: 'fake', model: 'deepseek-v4-flash' } as const

  for (let i = 0; i < count; i++) {
    const conv = createConversation(store, {
      workspaceId: ws.id,
      ...ref,
      title: `历史会话 ${String(i + 1).padStart(4, '0')}`,
    })
    const user = appendMessage(store, {
      conversationId: conv.id,
      role: 'user',
      content: `第 ${i + 1} 条历史请求：整理一遍变更并给出结论。`,
    })
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: ref.model,
      clientRequestId: crypto.randomUUID(),
      userMessageId: user.id,
      messageIdUpperBound: user.id,
      contextSnapshot: [],
    })
    markRunRunning(store, run.id)
    // 变更页按轮次分页，一轮里挂 24 条写入才够翻两页以上。
    appendStep(store, {
      runId: run.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'edit_file',
      toolCallId: `c${i}`,
      status: 'success',
      payload: {
        kind: 'tool_result',
        args: { path: `src/mod-${i}.ts` },
        action: { kind: 'edit', objectLabel: '文件', target: `src/mod-${i}.ts` },
        outcome: {
          status: 'success',
          executed: true,
          message: `编辑 ${24} 个文件`,
          fileChanges: Array.from({ length: 24 }, (_, k) => ({
            path: `src/mod-${i}/part-${k}.ts`,
            changeType: k % 5 === 0 ? 'created' : 'modified',
            additions: 3 + k,
            deletions: k,
          })),
        },
      },
    })
    appendStep(store, {
      runId: run.id,
      seq: 2,
      kind: 'text',
      content: `第 ${i + 1} 条：改动已落，回归通过。`,
    })
    appendMessage(store, {
      conversationId: conv.id,
      role: 'assistant',
      content: `第 ${i + 1} 条：改动已落，回归通过。`,
    })
    finishRun(store, run.id, { status: 'done', stopReason: 'completed' })
  }

  // 变更页按「写过文件的轮」分页，默认一页 10 轮：30 轮才翻得到第三页。
  {
    const conv = createConversation(store, {
      workspaceId: ws.id,
      ...ref,
      title: '变更分页',
    })
    for (let t = 0; t < 30; t++) {
      const user = appendMessage(store, {
        conversationId: conv.id,
        role: 'user',
        content: `第 ${t + 1} 轮：改一批文件。`,
      })
      const run = createRun(store, {
        conversationId: conv.id,
        workspaceId: ws.id,
        model: ref.model,
        clientRequestId: crypto.randomUUID(),
        userMessageId: user.id,
        messageIdUpperBound: user.id,
        contextSnapshot: [],
      })
      markRunRunning(store, run.id)
      appendStep(store, {
        runId: run.id,
        seq: 1,
        kind: 'tool_action',
        toolName: 'edit_file',
        toolCallId: `p${t}`,
        status: 'success',
        payload: {
          kind: 'tool_result',
          args: { path: `src/page-${t}.ts` },
          action: { kind: 'edit', objectLabel: '文件', target: `src/page-${t}.ts` },
          outcome: {
            status: 'success',
            executed: true,
            message: '编辑 6 个文件',
            fileChanges: Array.from({ length: 6 }, (_, k) => ({
              path: `src/page-${t}/f-${k}.ts`,
              changeType: k === 0 ? 'created' : 'modified',
              additions: 2 + k,
              deletions: k,
            })),
          },
        },
      })
      appendMessage(store, {
        conversationId: conv.id,
        role: 'assistant',
        content: `第 ${t + 1} 轮完成。`,
      })
      finishRun(store, run.id, { status: 'done', stopReason: 'completed' })
    }
  }

  // 1 / 4 / 12 并行子任务各一条：运行面板的 childRuns 读的是子会话上的 run。
  for (const fanout of [1, 4, 12]) {
    const parent = createConversation(store, {
      workspaceId: ws.id,
      ...ref,
      title: `并行子任务 ${fanout}`,
    })
    const user = appendMessage(store, {
      conversationId: parent.id,
      role: 'user',
      content: `拆成 ${fanout} 个子任务并行处理。`,
    })
    const run = createRun(store, {
      conversationId: parent.id,
      workspaceId: ws.id,
      model: ref.model,
      clientRequestId: crypto.randomUUID(),
      userMessageId: user.id,
      messageIdUpperBound: user.id,
      contextSnapshot: [],
    })
    markRunRunning(store, run.id)
    // 先建子会话再写派活 step：`nodes` 的每一格要带 `subagentId`，
    // 派活卡的图按它画格子，没有这一份就退成一个泛节点，量不到扇出。
    const children: { id: ConversationId; label: string }[] = []
    for (let k = 0; k < fanout; k++) {
      const child = createConversation(store, {
        workspaceId: ws.id,
        ...ref,
        title: `子任务 ${k + 1}`,
        // 机器会话带 source，`listConversations` 才把它挡在侧栏之外，与真实派活同形。
        source: 'temp',
        parentConversationId: parent.id,
      })
      children.push({ id: child.id, label: `子任务 ${k + 1}` })
    }
    const nodes: Record<string, NodeState> = {}
    for (const [k, c] of children.entries()) {
      nodes[`n${k}`] = {
        phase: 'done',
        label: c.label,
        kind: 'temp',
        subagentId: c.id,
        durationMs: 1200 + k * 40,
        output: `${c.label} 的产出。`,
      }
    }
    const dispatch = appendStep(store, {
      runId: run.id,
      seq: 1,
      kind: 'tool_action',
      // 扇出图只有 `workflow` 画得出来：`subagent` 的图恒为一格，
      // 格子由 `args.nodes` 决定，进度由 payload 的 `nodes` 按同一批 id 认领。
      toolName: 'workflow',
      toolCallId: `d${fanout}`,
      status: 'success',
      payload: {
        kind: 'tool_result',
        args: {
          goal: `拆成 ${fanout} 个子任务并行处理`,
          maxConcurrent: fanout,
          nodes: children.map((c, k) => ({
            id: `n${k}`,
            name: c.label,
            task: `处理第 ${k + 1} 份`,
          })),
        },
        action: { kind: 'run', objectLabel: '子任务', target: `${fanout} 个` },
        outcome: { status: 'success', executed: true, message: `派出 ${fanout} 个子任务` },
        nodes,
      },
    })
    for (const [k, c] of children.entries()) {
      const child = { id: c.id }
      const childRun = createRun(store, {
        conversationId: child.id,
        workspaceId: ws.id,
        model: ref.model,
        clientRequestId: crypto.randomUUID(),
        userMessageId: null,
        messageIdUpperBound: null,
        contextSnapshot: [],
        dispatch: { stepId: dispatch.id, nodeId: `n${k}` },
      })
      markRunRunning(store, childRun.id)
      appendStep(store, {
        runId: childRun.id,
        seq: 1,
        kind: 'tool_action',
        toolName: 'edit_file',
        toolCallId: `s${fanout}-${k}`,
        status: 'success',
        payload: {
          kind: 'tool_result',
          args: { path: `src/child-${fanout}-${k}.ts` },
          action: { kind: 'edit', objectLabel: '文件', target: `src/child-${fanout}-${k}.ts` },
          outcome: {
            status: 'success',
            executed: true,
            message: '编辑 2 个文件',
            fileChanges: [
              {
                path: `src/child-${fanout}-${k}.ts`,
                changeType: 'modified',
                additions: 9,
                deletions: 2,
              },
              {
                path: `src/child-${fanout}-${k}.test.ts`,
                changeType: 'created',
                additions: 30,
                deletions: 0,
              },
            ],
          },
        },
      })
      finishRun(store, childRun.id, { status: 'done', stopReason: 'completed' })
    }
    appendStep(store, {
      runId: run.id,
      seq: 2,
      kind: 'text',
      content: `${fanout} 个子任务已收尾。`,
    })
    appendMessage(store, {
      conversationId: parent.id,
      role: 'assistant',
      content: `${fanout} 个子任务已收尾。`,
    })
    finishRun(store, run.id, { status: 'done', stopReason: 'completed' })
  }
  store.close()
}

// ───────────────────────── 模拟 Provider ─────────────────────────

type ProviderMode = 'ok' | 'auth' | 'abort'

function sse(events: { type: string; [k: string]: unknown }[]): string {
  return `${events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n`).join('\n')}\n`
}

const USAGE = {
  input_tokens: 120,
  output_tokens: 40,
  input_tokens_details: { cached_tokens: 0 },
}

/** 第一轮：调 run_command 产出一份带唯一前缀的大输出。前缀保证正文库不会按内容去重。 */
function toolTurn(n: number, command: string): string {
  return sse([
    { type: 'response.created', response: { id: `resp_${n}` } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, name: 'run_command' },
    },
    {
      type: 'response.function_call_arguments.delta',
      item_id: `fc_${n}`,
      delta: JSON.stringify({ command }),
    },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call' } },
    {
      type: 'response.completed',
      response: { id: `resp_${n}`, status: 'completed', usage: USAGE },
    },
  ])
}

/** 第二轮：纯文本收尾。 */
function textTurn(n: number): string {
  return sse([
    { type: 'response.created', response: { id: `resp_${n}` } },
    { type: 'response.output_text.delta', delta: '负载轮次已收尾。' },
    {
      type: 'response.completed',
      response: { id: `resp_${n}`, status: 'completed', usage: USAGE },
    },
  ])
}

// ───────────────────────── 进程与两库读数 ─────────────────────────

interface ProcSample {
  rssBytes: number | null
  handles: number | null
  children: number | null
  tcp: number | null
}

/**
 * 一次 PowerShell 取全 serve 进程的读数。
 *
 * `Get-NetTCPConnection` 在部分环境不可用，失败时该项记 null 而不是让整次采样失败。
 */
async function sampleProcess(pid: number): Promise<ProcSample> {
  const script = `
$ErrorActionPreference='SilentlyContinue'
$self = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"
$kids = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}")
$tcp = @(Get-NetTCPConnection -OwningProcess ${pid})
[pscustomobject]@{
  rss = $(if ($self) { [int64]$self.WorkingSetSize } else { $null })
  handles = $(if ($self) { [int]$self.HandleCount } else { $null })
  children = $kids.Count
  tcp = $(if ($tcp) { $tcp.Count } else { $null })
} | ConvertTo-Json -Compress
`
  const proc = Bun.spawn(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script], {
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  try {
    const parsed = JSON.parse(out.trim()) as Record<string, number | null>
    return {
      rssBytes: parsed.rss ?? null,
      handles: parsed.handles ?? null,
      children: parsed.children ?? null,
      tcp: parsed.tcp ?? null,
    }
  } catch {
    return { rssBytes: null, handles: null, children: null, tcp: null }
  }
}

interface DbSample {
  mainBytes: number
  mainPages: number
  mainFreelist: number
  contentBytes: number
  contentPages: number
  contentFreelist: number
  conversations: number
  runs: number
  liveRuns: number
  resources: number
  blobs: number
  danglingRefs: number
  brokenBlobs: number
  orphanBlobs: number
  scheduleConvClusters: number
}

/** 两库读数。只读连接，每次重开——服务重启期间文件可能刚被换过句柄。 */
async function sampleDb(mainPath: string, contentPath: string): Promise<DbSample | null> {
  const mainBytes = (await Bun.file(mainPath).exists()) ? Bun.file(mainPath).size : 0
  const contentBytes = (await Bun.file(contentPath).exists()) ? Bun.file(contentPath).size : 0
  let db: Database | null = null
  try {
    db = new Database(mainPath, { readonly: true })
    db.exec(`ATTACH DATABASE '${contentPath.replaceAll("'", "''")}' AS c`)
    const num = (sql: string): number => {
      const row = db?.query<Record<string, number>, []>(sql).get()
      return row ? Number(Object.values(row)[0] ?? 0) : 0
    }
    return {
      mainBytes,
      contentBytes,
      mainPages: num('PRAGMA main.page_count'),
      mainFreelist: num('PRAGMA main.freelist_count'),
      contentPages: num('PRAGMA c.page_count'),
      contentFreelist: num('PRAGMA c.freelist_count'),
      conversations: num('SELECT COUNT(*) AS n FROM conversations'),
      runs: num('SELECT COUNT(*) AS n FROM runs'),
      liveRuns: num("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued','running')"),
      resources: num('SELECT COUNT(*) AS n FROM intermediate_resources'),
      blobs: num('SELECT COUNT(*) AS n FROM c.content_blobs'),
      danglingRefs: num(`SELECT COUNT(*) AS n FROM intermediate_resources r
        WHERE r.content_hash IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM c.content_blobs b WHERE b.content_hash = r.content_hash)`),
      brokenBlobs: num(`SELECT COUNT(*) AS n FROM c.content_blobs b
        WHERE b.chunk_count <> (SELECT COUNT(*) FROM c.content_chunks h WHERE h.content_hash = b.content_hash)`),
      orphanBlobs: num(`SELECT COUNT(*) AS n FROM c.content_blobs b
        WHERE NOT EXISTS (SELECT 1 FROM intermediate_resources r WHERE r.content_hash = b.content_hash)`),
      // 同一到期时机重复触发的形状是「两条同名会话建在同一秒内」。取最大簇大小，1 = 没有重复。
      scheduleConvClusters: num(`SELECT coalesce(MAX(n), 1) AS m FROM (
        SELECT COUNT(*) AS n FROM conversations
        WHERE title IN (SELECT title FROM schedules)
        GROUP BY title, created_at / 2000)`),
    }
  } catch {
    return null
  } finally {
    db?.close()
  }
}

// ───────────────────────── 负载 ─────────────────────────

interface Args {
  minutes: number
  payloadKb: number
  sampleSec: number
  restartMin: number
  cycleMs: number
}

function parseArgs(argv: string[]): Args {
  const get = (name: string, fallback: number): number => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : fallback
  }
  return {
    minutes: get('minutes', 125),
    payloadKb: get('payload-kb', 2048),
    sampleSec: get('sample-sec', 60),
    restartMin: get('restart-min', 25),
    cycleMs: get('cycle-ms', 12_000),
  }
}

interface Serve {
  proc: Bun.Subprocess
  pid: number
  port: number
  token: string
}

async function startServe(home: string, cwd: string): Promise<Serve> {
  const proc = Bun.spawn(
    [
      process.execPath,
      'run',
      join(ROOT, 'packages/cli/src/index.ts'),
      'serve',
      '--port',
      '0',
      '--host',
      '127.0.0.1',
      '--cwd',
      cwd,
      '--print-token',
      '--parent-pid',
      String(process.pid),
    ],
    {
      cwd: ROOT,
      env: { ...process.env, QYWORK_HOME: home },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let token = ''
  let port = 0
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && (!token || !port)) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    for (const line of buf.split('\n')) {
      const t = /^QYWORK_TOKEN=(.+)$/.exec(line.trim())
      if (t?.[1]) token = t[1]
      const p = /^QYWORK_PORT=(\d+)$/.exec(line.trim())
      if (p?.[1]) port = Number(p[1])
    }
  }
  reader.releaseLock()
  if (!token || !port) throw new Error('serve 启动超时或未打印令牌')
  // 剩余 stdout 持续排空，管道写满会让服务阻塞在写日志上。
  void (async () => {
    for await (const _ of proc.stdout) void _
  })().catch(() => {})
  void (async () => {
    for await (const _ of proc.stderr) void _
  })().catch(() => {})
  return { proc, pid: proc.pid, port, token }
}

async function main(): Promise<number> {
  const sub = Bun.argv[2]
  if (sub === 'seed') {
    const [dbPath, workspaceRoot, count] = Bun.argv.slice(3)
    if (!dbPath || !workspaceRoot || !count) {
      process.stderr.write('用法: bun run scripts/load-serve.ts seed <db> <工作区> <会话数>\n')
      return 2
    }
    seed(dbPath, workspaceRoot, Number(count))
    process.stdout.write(`已种 ${count} 条会话到 ${dbPath}\n`)
    return 0
  }

  const args = parseArgs(Bun.argv.slice(2))
  const home = join(BASE, 'home')
  const wsA = join(BASE, 'ws-a')
  const wsB = join(BASE, 'ws-b')
  const mainDb = join(home, 'qywork.sqlite3')
  const contentDb = join(home, 'qywork_content.sqlite3')

  await rm(BASE, { recursive: true, force: true })
  for (const d of [home, wsA, wsB]) await mkdir(d, { recursive: true })

  const payload = `${'负载正文行 payload line for the content store.\n'.repeat(Math.ceil((args.payloadKb * 1024) / 60))}`
  for (const d of [wsA, wsB]) await writeFile(join(d, 'payload.txt'), payload, 'utf8')

  const shell = commandShell()
  if (!shell) throw new Error('这台机器上没有可用的 shell，run_command 不会注册')
  const posix = shell.argv.includes('-c')
  const bigOutput = (nonce: string): string =>
    posix ? `printf '%s\\n' '${nonce}'; cat payload.txt` : `'${nonce}'; Get-Content payload.txt`

  // ── 模拟 Provider ──
  const stats = { requests: 0, ok: 0, auth: 0, abort: 0 }
  const mode = { current: 'ok' as ProviderMode }
  let turn = 0
  const provider = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      stats.requests++
      const body = await req.text()
      if (mode.current === 'auth') {
        stats.auth++
        return new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      }
      const second = body.includes('function_call_output')
      turn++
      if (mode.current === 'abort' && !second) {
        stats.abort++
        // 只发开头就断流：适配器按流意外结束处理，run 落错误终态。
        return new Response(sse([{ type: 'response.created', response: { id: `resp_${turn}` } }]), {
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      stats.ok++
      const bodyText = second
        ? textTurn(turn)
        : toolTurn(turn, bigOutput(`nonce-${turn}-${crypto.randomUUID()}`))
      return new Response(bodyText, { headers: { 'content-type': 'text/event-stream' } })
    },
  })

  await writeFile(
    join(home, 'config.json'),
    JSON.stringify({
      active: { provider: 'load', model: 'deepseek-v4-flash' },
      providers: {
        load: {
          kind: 'openai_responses',
          apiKey: 'sk-load',
          baseUrl: `http://127.0.0.1:${provider.port}/v1`,
          models: { 'deepseek-v4-flash': {} },
        },
      },
      // full 是为了让 run_command 不等权限回执：负载验的是状态与空间，不是裁决。
      mode: 'full',
    }),
    'utf8',
  )

  const events: string[] = []
  const note = (kind: string, data: Record<string, unknown>): void => {
    events.push(JSON.stringify({ at: new Date().toISOString(), kind, ...data }))
  }

  /*
   * 夹具：两个工作区与两条一分钟间隔的任务。
   *
   * HTTP 没有建任务的入口——任务由模型工具 `create_schedule` 建，界面只列出、删除与试跑。
   * 负载要的是确定的触发节奏，所以这里直接经仓储建，`created_at` 回拨到两分钟前让首轮立即到期。
   */
  const fixture = new Store({ path: mainDb })
  const wsIds: Record<string, string> = {
    A: upsertWorkspace(fixture, wsA, 'A').id,
    B: upsertWorkspace(fixture, wsB, 'B').id,
  }
  const scheduleIds: Record<string, string> = {}
  for (const [name, path] of [
    ['A', wsA],
    ['B', wsB],
  ] as const) {
    const made = createSchedule(fixture, path, {
      title: `负载任务 ${name}`,
      prompt: `${name} 的固定负载：读一遍 payload.txt 并汇报字节数。`,
      kind: 'interval',
      everyMinutes: 1,
    })
    fixture.db
      .query('UPDATE schedules SET created_at = ? WHERE id = ?')
      .run(Date.now() - 120_000, made.id)
    scheduleIds[name] = made.id
  }
  fixture.close()

  let serve = await startServe(home, wsA)
  const api = (path: string, init?: RequestInit): Promise<Response> =>
    fetch(`http://127.0.0.1:${serve.port}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${serve.token}`, ...(init?.headers ?? {}) },
    })

  const jsonOf = async <T>(res: Response): Promise<T> => (await res.json()) as T

  note('start', { pid: serve.pid, port: serve.port, wsIds, scheduleIds, args })

  const rows: string[] = [
    'at,phase,cycle,rssBytes,handles,children,tcp,mainBytes,mainPages,mainFreelist,contentBytes,contentPages,contentFreelist,conversations,runs,liveRuns,resources,blobs,orphanBlobs,danglingRefs,brokenBlobs,scheduleCluster,providerRequests',
  ]
  const failures: string[] = []
  let cycle = 0
  const sample = async (phase: string): Promise<DbSample | null> => {
    const [p, d] = await Promise.all([sampleProcess(serve.pid), sampleDb(mainDb, contentDb)])
    rows.push(
      [
        new Date().toISOString(),
        phase,
        cycle,
        p.rssBytes ?? '',
        p.handles ?? '',
        p.children ?? '',
        p.tcp ?? '',
        d?.mainBytes ?? '',
        d?.mainPages ?? '',
        d?.mainFreelist ?? '',
        d?.contentBytes ?? '',
        d?.contentPages ?? '',
        d?.contentFreelist ?? '',
        d?.conversations ?? '',
        d?.runs ?? '',
        d?.liveRuns ?? '',
        d?.resources ?? '',
        d?.blobs ?? '',
        d?.orphanBlobs ?? '',
        d?.danglingRefs ?? '',
        d?.brokenBlobs ?? '',
        d?.scheduleConvClusters ?? '',
        stats.requests,
      ].join(','),
    )
    await writeFile(join(BASE, 'samples.csv'), `${rows.join('\n')}\n`, 'utf8')
    if (d && d.danglingRefs > 0) failures.push(`悬空引用 ${d.danglingRefs} 条（${phase}）`)
    if (d && d.brokenBlobs > 0) failures.push(`正文分片缺失 ${d.brokenBlobs} 条（${phase}）`)
    if (d && d.scheduleConvClusters > 1) {
      failures.push(`同一到期时机建了 ${d.scheduleConvClusters} 条会话（${phase}）`)
    }
    return d
  }

  /** 停掉两条任务、等在跑的收尾，取三次静止读数，再恢复。 */
  /** 启停一条任务。只发 `enabled`，与面板的开关走同一条部分更新路径。 */
  const setEnabled = async (name: 'A' | 'B', enabled: boolean): Promise<void> => {
    const res = await api(`/api/schedules/${scheduleIds[name]}?ws=${wsIds[name]}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled }),
    })
    if (!res.ok) failures.push(`任务 ${name} 启停返回 ${res.status}：${await res.text()}`)
  }

  const quiesce = async (label: string): Promise<void> => {
    for (const name of ['A', 'B'] as const) await setEnabled(name, false)
    const before = stats.requests
    await Bun.sleep(60_000)
    for (let i = 0; i < 3; i++) {
      const quiet = await sample(`静止-${label}`)
      if (quiet && quiet.liveRuns > 0) {
        failures.push(`静止-${label} 期间仍有 ${quiet.liveRuns} 条未落终态的 Run`)
      }
      await Bun.sleep(20_000)
    }
    note('quiesce', { label, requestsDuringQuiesce: stats.requests - before })
    for (const name of ['A', 'B'] as const) await setEnabled(name, true)
  }

  /** 一次消息轮次。`interrupt` 为真时在收到首个工具事件后打断。 */
  const driveRun = async (interrupt: boolean): Promise<string> => {
    const made = await jsonOf<{ conversation: { id: string } }>(
      await api(`/api/conversations?ws=${wsIds.A}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: `消息轮次 ${cycle}` }),
      }),
    )
    const id = made.conversation.id
    const ws = new WebSocket(`ws://127.0.0.1:${serve.port}/stream?token=${serve.token}&origin=cli`)
    const done = Promise.withResolvers<string>()
    let interrupted = false
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'hello', token: serve.token, origin: 'cli', subscribe: [id] }))
      setTimeout(() => {
        ws.send(
          JSON.stringify({
            type: 'message.send',
            clientRequestId: crypto.randomUUID(),
            conversationId: id,
            content: '跑一遍固定负载。',
          }),
        )
      }, 200)
    })
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(String(e.data)) as { event?: { type: string; status?: string } }
      const type = msg.event?.type
      if (!type) return
      if (interrupt && !interrupted && (type === 'tool.started' || type === 'text.delta')) {
        interrupted = true
        ws.send(JSON.stringify({ type: 'conversation.interrupt', conversationId: id }))
      }
      if (type === 'run.finished') done.resolve(msg.event?.status ?? 'unknown')
      if (type === 'run.error') done.resolve('error')
    })
    ws.addEventListener('error', () => done.resolve('socket_error'))
    const timer = setTimeout(() => done.resolve('timeout'), 180_000)
    const outcome = await done.promise
    clearTimeout(timer)
    ws.close()
    return `${id}:${outcome}`
  }

  const stopServe = async (): Promise<void> => {
    serve.proc.kill()
    await serve.proc.exited
    // Windows 上 SQLite 句柄释放有延迟，重开之前留一格。
    await Bun.sleep(1500)
  }

  /*
   * 每次触发的核对。
   *
   * `lastRunAt` 每推进一次就是一次认领；同一次推进必须只对应一条新会话，
   * 而那条会话上的 Run 必须在超时之前落到终态。两条都由这一份记录裁决，
   * 不从会话总数反推——删除会把计数改回去。
   */
  interface TriggerRecord {
    lastRunAt: number
    conversationIds: Set<string>
    pending: { conversationId: string; at: number }[]
    triggers: number
  }
  const trigger: Record<string, TriggerRecord> = {
    A: { lastRunAt: 0, conversationIds: new Set(), pending: [], triggers: 0 },
    B: { lastRunAt: 0, conversationIds: new Set(), pending: [], triggers: 0 },
  }
  const TERMINAL_BUDGET_MS = 240_000

  type ScheduleRow = {
    id: string
    lastRunAt: number | null
    lastRun: { conversationId: string; runId: string | null; status: string | null } | null
  }
  const pollSchedules = async (): Promise<void> => {
    for (const name of ['A', 'B'] as const) {
      const res = await api(`/api/schedules?ws=${wsIds[name]}`)
      if (!res.ok) continue
      const payload = await jsonOf<{ schedules: ScheduleRow[] }>(res)
      const row = payload.schedules.find((s) => s.id === scheduleIds[name])
      if (!row?.lastRunAt || !row.lastRun) continue
      const rec = trigger[name]!
      if (row.lastRunAt > rec.lastRunAt) {
        rec.lastRunAt = row.lastRunAt
        rec.triggers++
        if (rec.conversationIds.has(row.lastRun.conversationId)) {
          failures.push(`任务 ${name} 的两次触发指向同一条会话 ${row.lastRun.conversationId}`)
        }
        rec.conversationIds.add(row.lastRun.conversationId)
        rec.pending.push({ conversationId: row.lastRun.conversationId, at: Date.now() })
      }
      // 已落终态的从待核对里摘掉；超时仍不是终态的记一条失败。
      const settled = new Set(['done', 'failed', 'interrupted'])
      const still: { conversationId: string; at: number }[] = []
      for (const p of rec.pending) {
        const isCurrent = p.conversationId === row.lastRun.conversationId
        if (isCurrent && row.lastRun.status && settled.has(row.lastRun.status)) continue
        if (!isCurrent) continue
        if (Date.now() - p.at > TERMINAL_BUDGET_MS) {
          failures.push(
            `任务 ${name} 的触发 ${p.conversationId} 超过 ${TERMINAL_BUDGET_MS / 1000} 秒仍无终态（当前 ${row.lastRun.status ?? '无执行记录'}）`,
          )
          continue
        }
        still.push(p)
      }
      rec.pending = still
    }
  }

  const deadline = Date.now() + args.minutes * 60_000
  let nextSample = Date.now()
  let nextRestart = Date.now() + args.restartMin * 60_000
  let quiesced = false

  try {
    while (Date.now() < deadline) {
      cycle++
      mode.current = cycle % 5 === 3 ? 'auth' : cycle % 5 === 0 ? 'abort' : 'ok'
      const outcome = await driveRun(cycle % 4 === 2)
      note('run', { cycle, mode: mode.current, outcome })
      await pollSchedules()

      // 删掉最老的几条已收尾会话并留下四条：净增量压到零附近，回收与页复用才进得了稳态。
      // 列表按 updated_at DESC，末尾即最老。两个工作区轮着删，跨工作区那条路径同样走到。
      {
        const target = cycle % 4 === 0 ? 'B' : 'A'
        const list = await jsonOf<{ conversations: { id: string; title: string }[] }>(
          await api(`/api/conversations?ws=${wsIds[target]}`),
        )
        const spare = Math.max(0, Math.min(3, list.conversations.length - 4))
        for (const v of spare > 0 ? list.conversations.slice(-spare) : []) {
          const res = await api(`/api/conversations/${v.id}?ws=${wsIds[target]}`, {
            method: 'DELETE',
          })
          note('delete', { ws: target, id: v.id, status: res.status })
        }
      }

      if (Date.now() >= nextSample) {
        await sample('负载')
        nextSample = Date.now() + args.sampleSec * 1000
      }

      if (!quiesced && cycle >= 6) {
        quiesced = true
        await quiesce('早期')
      }

      if (Date.now() >= nextRestart) {
        nextRestart = Date.now() + args.restartMin * 60_000
        const before = await sample('重启前')
        await stopServe()
        // 服务停止期间删掉一条会话：级联清掉引用行，正文成为孤儿，
        // 下次启动的回收是唯一能清掉它的路径。
        const store = new Store({ path: mainDb })
        const victim = store.db
          .query<{ id: string }, []>(
            `SELECT c.id AS id FROM conversations c
             JOIN runs r ON r.conversation_id = c.id
             JOIN intermediate_resources i ON i.run_id = r.id
             WHERE i.content_hash IS NOT NULL LIMIT 1`,
          )
          .get()
        if (victim) deleteConversation(store, victim.id as ConversationId)
        store.close()
        await Bun.sleep(500)
        const downSample = await sampleDb(mainDb, contentDb)
        serve = await startServe(home, wsA)
        await Bun.sleep(4000)
        const after = await sampleDb(mainDb, contentDb)
        note('restart', {
          pid: serve.pid,
          orphansBefore: downSample?.orphanBlobs ?? null,
          orphansAfter: after?.orphanBlobs ?? null,
          liveRunsBefore: before?.liveRuns ?? null,
          liveRunsAfter: after?.liveRuns ?? null,
        })
        if ((downSample?.orphanBlobs ?? 0) > 0 && (after?.orphanBlobs ?? 0) > 0) {
          failures.push(
            `启动回收没有清掉孤儿正文：停机时 ${downSample?.orphanBlobs}，启动后 ${after?.orphanBlobs}`,
          )
        }
        await sample('重启后')
      }

      await writeFile(join(BASE, 'events.jsonl'), `${events.join('\n')}\n`, 'utf8')
      await Bun.sleep(args.cycleMs)
    }

    await quiesce('收尾')
    const last = await sample('收尾')
    note('end', {
      cycle,
      stats,
      last,
      triggers: { A: trigger.A?.triggers ?? 0, B: trigger.B?.triggers ?? 0 },
    })
  } finally {
    await stopServe().catch(() => {})
    provider.stop(true)
    // 服务停掉之后再读正文：把每条仍被引用的资源真读一段回来，
    // 只查引用行只能证明账本自洽，证明不了字节还在。
    const readback = { checked: 0, missing: 0, sizeMismatch: 0 }
    try {
      const store = new Store({ path: mainDb })
      const { ContentStore, contentPathFor } = await import('@qywork/store')
      const content = new ContentStore(contentPathFor(mainDb))
      const refs = store.db
        .query<{ content_hash: string; size_bytes: number }, []>(
          `SELECT content_hash, size_bytes FROM intermediate_resources
           WHERE content_hash IS NOT NULL LIMIT 200`,
        )
        .all()
      for (const r of refs) {
        readback.checked++
        const info = content.info(r.content_hash)
        if (!info) {
          readback.missing++
          continue
        }
        if (info.originalBytes !== r.size_bytes) readback.sizeMismatch++
        const head = content.readRange(r.content_hash, 0, 64)
        if (!head || head.byteLength === 0) readback.missing++
      }
      content.close()
      store.close()
    } catch (err) {
      failures.push(`正文读回失败：${err instanceof Error ? err.message : String(err)}`)
    }
    if (readback.missing > 0) failures.push(`仍被引用但读不回来的正文 ${readback.missing} 条`)
    if (readback.sizeMismatch > 0) {
      failures.push(`账本长度与正文长度不一致 ${readback.sizeMismatch} 条`)
    }
    note('readback', readback)
    await writeFile(join(BASE, 'events.jsonl'), `${events.join('\n')}\n`, 'utf8')
    await writeFile(
      join(BASE, 'summary.json'),
      JSON.stringify(
        {
          args,
          cycles: cycle,
          provider: stats,
          triggers: { A: trigger.A?.triggers ?? 0, B: trigger.B?.triggers ?? 0 },
          readback,
          failures,
        },
        null,
        2,
      ),
      'utf8',
    )
  }

  process.stdout.write(
    failures.length === 0
      ? `\n负载结束：${cycle} 轮，模拟 Provider 请求 ${stats.requests} 次，未命中失败项\n`
      : `\n负载结束：${cycle} 轮，失败项 ${failures.length} 条\n${failures.join('\n')}\n`,
  )
  return failures.length === 0 ? 0 : 1
}

process.exit(await main())
