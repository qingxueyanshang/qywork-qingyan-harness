#!/usr/bin/env bun
/**
 * 记忆写入决策点的真实模型重放。
 *
 * 从账本中取出三类决策点，重建决策点处发给模型的那一次请求，取模型的下一步输出，记录是否调用 `write_memory` 及写入内容：
 *
 * - `write`：模型调用 `write_memory` 的那一次请求；
 * - `correction-first` / `correction-last`：用户消息含纠正或偏好用词、该轮未写入记忆时，该轮第一次与最后一次请求；
 * - `control`：其余用户消息中均匀抽取的若干轮，取该轮最后一次请求。
 *
 * 用词筛选只用于找出候选，判分以标注文件为准。
 *
 * 系统提示词、工具说明与记忆索引的格式取自当前源码，历史、工具结果与决策点处的记忆条目取自账本。
 * 修改记忆定义前后各执行一次，即为同一批决策点在两种定义下的对照。
 *
 * 不修改主账本与任何工作区文件：主账本与正文库先以 `VACUUM INTO` 复制到 `.tmp/memory-replay/`，
 * 每次执行再复制一份账本用于截断；工具一律替换为不执行的桩，模型完成第一次响应后即中止。
 *
 *   bun run scripts/memory-replay.ts --list                          # 列出决策点
 *   bun run scripts/memory-replay.ts --out=baseline --samples=2      # 重放全部决策点
 *   bun run scripts/memory-replay.ts --out=x --only=<点 id>,<点 id>  # 只重放指定决策点
 *   bun run scripts/memory-replay.ts --score=baseline                # 按 labels.json 判分
 */

import { Database } from 'bun:sqlite'
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { appendFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AgentLoop,
  type CompactionPort,
  type LoopPersistence,
  type ToolContextBase,
  ToolRegistry,
} from '@qywork/agent'
import {
  buildAdapter,
  type LlmAdapter,
  type ProviderProfile,
  type WireMessage,
  type WireToolCall,
} from '@qywork/ai'
import type { Attachment, ConversationId, MessageId, RunId } from '@qywork/core'
import {
  buildHistory,
  buildSystemPrompt,
  buildTailNotes,
  dataPath,
  listMediaModels,
  loadConfig,
  type ModelRef,
  type QyConfig,
  RuntimeCompaction,
  RuntimeSink,
  resolveModel,
} from '@qywork/runtime'
import {
  ContentStore,
  contentPathFor,
  conversationRejectsImages,
  getConversation,
  getRun,
  getWorkspace,
  Store,
} from '@qywork/store'
import { registerBuiltinTools } from '@qywork/tools'
import { withAttachments } from '../packages/runtime/src/session.ts'

const ROOT = join(import.meta.dir, '..', '.tmp', 'memory-replay')
const LEDGER = join(ROOT, 'ledger.sqlite3')
const CONTENT = join(ROOT, 'ledger_content.sqlite3')
const LABELS = join(ROOT, 'labels.json')
const NL = String.fromCharCode(10)
const STOP = '重放已取得第一次响应'
const REPLAY_TIMEOUT_MS = 20 * 60_000
const CONTROL_COUNT = 12

/** 纠正与偏好的候选用词。只用于缩小候选范围，是否应写入由标注决定。 */
const SIGNAL =
  /以后|每次|下次|今后|一律|永远|总是|记住|我说过|说过了|说了多少|又(?:把|给|在|是)|谁让你|我要的是|不是让你|别再|不要再|别给我|不要给我|我不喜欢|我喜欢|我习惯|太(?:AI|平庸|空|挤|多)|不准|禁止/

type Kind = 'write' | 'correction-first' | 'correction-last' | 'control'

interface Point {
  id: string
  kind: Kind
  conversationId: string
  runId: string
  /** 截断起点：该次响应产生的第一个 step 的 seq，含该 seq 在内的后续 step 全部移除。 */
  startSeq: number
  /** 截断起点的时间，用于同一会话内按时间倒序处理。 */
  at: number
  workspace: string
  model: string
  message: string
  /** 写入点在账本中原有的写入首行。 */
  original?: string
  /**
   * 会话压缩记录的处理方式。账本只保存最新一版压缩记录：其摘要线与收纳线都在决策点之前时沿用（`keep`），
   * 摘要可能比决策点处更概括；任一条线在决策点之后时清除（`clear`），按未压缩的历史发送，可能超出窗口。
   */
  manifest: 'keep' | 'clear'
}

interface Result {
  id: string
  sample: number
  tools: string[]
  writes: { key: string; scope: string; content: string }[]
  text: string
  error: string | null
  definition: string
}

/** `either` 表示写与不写均可接受，不计入判分，写入内容照常输出。 */
interface Label {
  expect: 'write' | 'none' | 'either'
  rule?: string
}

function line(s: string): void {
  process.stdout.write(s + NL)
}

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit?.slice(name.length + 3)
}

/** 主账本与正文库各复制一份一致的快照。已存在时沿用，修改定义前后使用同一份数据。 */
function snapshot(): void {
  if (existsSync(LEDGER) && existsSync(CONTENT)) return
  const main = dataPath()
  for (const [from, to] of [
    [main, LEDGER],
    [contentPathFor(main), CONTENT],
  ] as const) {
    const db = new Database(from, { readonly: true })
    db.run(`VACUUM INTO '${to.replaceAll("'", "''")}'`)
    db.close()
  }
}

function firstLine(text: string): string {
  return (
    text
      .split(NL)
      .find((l) => l.trim())
      ?.trim() ?? ''
  )
}

/** 一次响应的截断起点：同一 `provider_batch_id` 的最小 seq。 */
function batchStart(db: Database, runId: string, batchId: string | null, seq: number): number {
  if (!batchId) return seq
  const row = db
    .query<{ s: number }, [string, string]>(
      'SELECT min(seq) s FROM steps WHERE run_id = ? AND provider_batch_id = ?',
    )
    .get(runId, batchId)
  return row?.s ?? seq
}

function selectPoints(db: Database): Point[] {
  const runInfo = db.query<
    {
      conversation_id: string
      model: string
      root_path: string
      content: string | null
      created_at: number
    },
    [string]
  >(
    `SELECT r.conversation_id, r.model, w.root_path, m.content, r.created_at
       FROM runs r JOIN conversations c ON c.id = r.conversation_id
       JOIN workspaces w ON w.id = c.workspace_id
       LEFT JOIN messages m ON m.id = r.user_message_id
      WHERE r.id = ?`,
  )
  const manifestOf = db.query<{ m: string | null }, [string]>(
    'SELECT compaction_manifest m FROM conversations WHERE id = ?',
  )
  const boundOf = db.query<{ b: string | null }, [string]>(
    'SELECT coalesce(message_id_upper_bound, user_message_id) b FROM runs WHERE id = ?',
  )
  /** 压缩线是否位于决策点之前。线由消息 id 与可选的 `<runId>:<seq>` 定位，消息 id 按时间排序。 */
  const cutBefore = (
    cut: { messageId?: string | null; step?: string } | undefined,
    bound: string,
    runId: string,
    startSeq: number,
  ): boolean => {
    if (!cut?.messageId) return true
    if (cut.messageId !== bound) return cut.messageId < bound
    if (!cut.step) return true
    const [stepRun, stepSeq] = cut.step.split(':')
    return stepRun !== runId || Number(stepSeq) < startSeq
  }
  const stepAt = db.query<{ created_at: number }, [string, number]>(
    'SELECT created_at FROM steps WHERE run_id = ? AND seq = ?',
  )
  const make = (kind: Kind, runId: string, startSeq: number, original?: string): Point | null => {
    const info = runInfo.get(runId)
    if (!info) return null
    const at = stepAt.get(runId, startSeq)?.created_at ?? info.created_at
    const bound = boundOf.get(runId)?.b ?? ''
    const manifest = JSON.parse(manifestOf.get(info.conversation_id)?.m ?? 'null') as {
      compactedThroughMessageId?: string | null
      compactedThroughStep?: string
      condensedThrough?: { messageId?: string; step?: string }
    } | null
    const kept =
      !manifest ||
      (cutBefore(
        {
          messageId: manifest.compactedThroughMessageId ?? null,
          ...(manifest.compactedThroughStep ? { step: manifest.compactedThroughStep } : {}),
        },
        bound,
        runId,
        startSeq,
      ) &&
        cutBefore(manifest.condensedThrough, bound, runId, startSeq))
    return {
      id: `${runId}:${startSeq}`,
      kind,
      conversationId: info.conversation_id,
      runId,
      startSeq,
      at,
      workspace: info.root_path,
      model: info.model,
      message: (info.content ?? '').replace(/\s+/g, ' ').slice(0, 160),
      ...(original !== undefined ? { original } : {}),
      manifest: kept ? 'keep' : 'clear',
    }
  }

  const points: Point[] = []
  const seenRuns = new Set<string>()
  const writes = db
    .query<{ run_id: string; seq: number; provider_batch_id: string | null; payload: string }, []>(
      `SELECT s.run_id, s.seq, s.provider_batch_id, s.payload
         FROM steps s JOIN runs r ON r.id = s.run_id
         JOIN conversations c ON c.id = r.conversation_id
        WHERE s.tool_name = 'write_memory' AND c.source IS NULL
        ORDER BY s.created_at`,
    )
    .all()
  for (const w of writes) {
    if (seenRuns.has(w.run_id)) continue
    seenRuns.add(w.run_id)
    const args = (JSON.parse(w.payload) as { args?: { key?: unknown; content?: unknown } }).args
    const p = make(
      'write',
      w.run_id,
      batchStart(db, w.run_id, w.provider_batch_id, w.seq),
      `${String(args?.key)}：${firstLine(String(args?.content ?? ''))}`,
    )
    if (p) points.push(p)
  }

  const userRuns = db
    .query<{ run_id: string; content: string }, []>(
      `SELECT r.id run_id, m.content FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         JOIN runs r ON r.id = (
           SELECT id FROM runs WHERE user_message_id = m.id ORDER BY created_at LIMIT 1)
        WHERE m.role = 'user' AND c.source IS NULL
        ORDER BY m.created_at`,
    )
    .all()
    .filter((r) => !seenRuns.has(r.run_id) && !r.content.startsWith('['))
  const batches = db.query<{ provider_batch_id: string; s: number }, [string]>(
    `SELECT provider_batch_id, min(seq) s FROM steps
      WHERE run_id = ? AND provider_batch_id IS NOT NULL
      GROUP BY provider_batch_id ORDER BY s`,
  )
  const boundaries = (runId: string): number[] => batches.all(runId).map((b) => b.s)

  for (const r of userRuns.filter((u) => SIGNAL.test(u.content))) {
    const starts = boundaries(r.run_id)
    if (!starts.length) continue
    const first = make('correction-first', r.run_id, starts[0] as number)
    if (first) points.push(first)
    if (starts.length > 1) {
      const last = make('correction-last', r.run_id, starts.at(-1) as number)
      if (last) points.push(last)
    }
  }

  const ordinary = userRuns.filter((u) => !SIGNAL.test(u.content) && boundaries(u.run_id).length)
  const step = Math.max(1, Math.floor(ordinary.length / CONTROL_COUNT))
  for (
    let i = 0;
    i < ordinary.length && points.filter((p) => p.kind === 'control').length < CONTROL_COUNT;
    i += step
  ) {
    const r = ordinary[i] as { run_id: string }
    const p = make('control', r.run_id, boundaries(r.run_id).at(-1) as number)
    if (p) points.push(p)
  }
  return points
}

/** 把会话截断到决策点：之后的消息、run 与本 run 中从截断起点开始的 step 全部删除。 */
function truncate(store: Store, p: Point): void {
  const run = getRun(store, p.runId as RunId)
  if (!run) throw new Error(`账本中没有 run ${p.runId}`)
  const bound = run.messageIdUpperBound ?? run.userMessageId
  store.tx(() => {
    store.db
      .query('DELETE FROM runs WHERE conversation_id = ? AND created_at > ?')
      .run(p.conversationId, run.createdAt)
    if (bound) {
      store.db
        .query('DELETE FROM messages WHERE conversation_id = ? AND id > ?')
        .run(p.conversationId, bound)
    }
    store.db.query('DELETE FROM steps WHERE run_id = ? AND seq >= ?').run(p.runId, p.startSeq)
    if (p.manifest === 'clear') {
      store.db
        .query('UPDATE conversations SET compaction_manifest = NULL WHERE id = ?')
        .run(p.conversationId)
    }
  })
}

/** 决策点处的记忆条目按当前源码的格式重新生成：索引标题与条目格式属于记忆定义的一部分。 */
function currentMemoryNote(workspaceRoot: string, stored: string): string {
  const memories = stored
    .split(NL)
    .filter((l) => l.startsWith('- '))
    .map((l) => {
      const i = l.indexOf('：')
      return { key: l.slice(2, i), preview: l.slice(i + 1) }
    })
  const note = buildTailNotes({ workspaceRoot, platform: process.platform, mode: 'auto', memories })
  return note.find((n) => n.group === 'memory')?.content ?? stored
}

function stubRegistry(config: QyConfig): ToolRegistry {
  const all = new ToolRegistry()
  registerBuiltinTools(all, {
    delegate: true,
    plugins: true,
    mcpConfig: true,
    browser: true,
    desktop: true,
    canvas: config.mediaEnabled !== false,
    office: true,
    media:
      config.mediaEnabled !== false
        ? [...new Set(listMediaModels(config).map((m) => m.output))]
        : [],
  })
  const stub = new ToolRegistry()
  for (const spec of all.list()) {
    stub.register({
      ...spec,
      fn: async () => ({ status: 'failure', executed: false, message: '重放不执行工具' }),
    })
  }
  return stub
}

/** 会话记录的接口配置了该模型时使用它；会话中途换过模型时，按模型 id 查找所属接口。 */
function targetFor(config: QyConfig, provider: string, model: string): ModelRef | string {
  return config.providers[provider]?.models[model] ? { provider, model } : model
}

function profileFor(config: QyConfig, target: ModelRef | string): ProviderProfile {
  const stored = resolveModel(config, target)
  if (!stored) throw new Error(`配置中没有模型 ${JSON.stringify(target)}`)
  return {
    kind: stored.kind,
    apiKey: stored.apiKey ?? '',
    model: stored.model,
    ...(stored.baseUrl ? { baseUrl: stored.baseUrl } : {}),
    ...(stored.headers ? { headers: stored.headers } : {}),
    ...(stored.spec ? { spec: stored.spec } : {}),
    ...(stored.transport ? { transport: stored.transport } : {}),
  }
}

async function replay(
  store: Store,
  content: ContentStore,
  config: QyConfig,
  p: Point,
  sample: number,
): Promise<Result> {
  const conversation = getConversation(store, p.conversationId as ConversationId)
  const run = getRun(store, p.runId as RunId)
  if (!conversation || !run) throw new Error(`账本中没有 ${p.id}`)
  const workspaceRoot = getWorkspace(store, conversation.workspaceId)?.rootPath ?? p.workspace
  const target = targetFor(config, conversation.provider, run.model)
  const resolved = resolveModel(config, target)
  const adapter = buildAdapter(profileFor(config, target))
  const spec = adapter.spec
  const registry = stubRegistry(config)
  const names = new Set(registry.list().map((s) => s.name))
  const systemPrompt = buildSystemPrompt(
    names,
    spec.outputLimitNote && spec.maxOutputTokens ? spec.maxOutputTokens : undefined,
  )
  const preserveAssistantReasoning = spec.chatReasoningProtocol !== 'standard'
  const bound = (run.messageIdUpperBound ?? run.userMessageId) as MessageId | null
  const history: WireMessage[] = (
    await buildHistory(
      store,
      p.conversationId as ConversationId,
      bound,
      (text, list) => withAttachments(workspaceRoot, text, list as Attachment[]),
      { preserveAssistantReasoning },
    )
  ).map((m) =>
    m.role === 'context' && m._group === 'memory' && typeof m.content === 'string'
      ? { ...m, content: currentMemoryNote(workspaceRoot, m.content) }
      : m,
  )
  const projection = new RuntimeCompaction({
    store,
    conversationId: p.conversationId as ConversationId,
    messageIdUpperBound: bound,
    summarize: async () => null,
    preserveAssistantReasoning,
  })
  const compaction: CompactionPort = {
    project: (messages) => projection.project(messages),
    run: async () => ({ status: 'skipped', reasonCode: 'nothing_to_fold' }),
  }

  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(new Error('重放超时')), REPLAY_TIMEOUT_MS)
  const calls: WireToolCall[] = []
  let text = ''
  let answered = false
  let failure: string | null = null
  /*
   * 工具调用从模型的响应流中记录，不从工具执行记录中取：同一次响应的调用按波次执行，
   * 记录执行只能取得已执行的波次，排在后面的 `write_memory` 会被遗漏。
   * 第一次带内容的响应结束后，下一次请求在发出前中止。
   */
  const recording: LlmAdapter = {
    ...(adapter.endpoint ? { endpoint: adapter.endpoint } : {}),
    kind: adapter.kind,
    spec,
    transmits: adapter.transmits,
    async *stream(req) {
      if (answered) {
        abort.abort(new Error(STOP))
        throw new Error(STOP)
      }
      for await (const ev of adapter.stream(req)) {
        if (ev.type === 'tool_calls') calls.push(...ev.calls)
        if (ev.type === 'text_delta') text += ev.delta
        yield ev
      }
      if (calls.length || text) answered = true
    },
  }
  let seq = 1_000_000
  const persist: LoopPersistence = {
    nextSeq: () => seq++,
    landUserStep: () => crypto.randomUUID(),
    openTextStep: () => `text-${seq}`,
    openThinkingStep: () => `thinking-${seq}`,
    failThinkingSteps: () => {},
    appendText: () => {},
    openToolStep: (_run, s) => `tool-${s}`,
    markExecuting: () => {},
    settleTool: (_id, _status, outcome) => outcome,
    saveUsage: () => {},
    recordCompaction: () => {},
    openRequest: (input) => `request-${input.turnIndex}-${input.retryIndex}`,
    markRequestSent: () => {},
    settleRequest: (_id, status, _usage, code, _finish, message) => {
      if (status !== 'received') failure = `${status} ${code ?? ''} ${message ?? ''}`.trim()
    },
  }
  const runId = `rn_replay_${crypto.randomUUID()}` as RunId
  const imagesRejected = conversationRejectsImages(
    store,
    p.conversationId as ConversationId,
    resolved?.provider ?? conversation.provider,
    spec.id,
  )
  const effort = resolved?.effort
  const makeToolContext = (id: RunId): ToolContextBase => ({
    workspaceRoot,
    conversationId: p.conversationId,
    runId: id,
    model: run.model,
    contextWindow: spec.contextWindow,
    density: spec.density,
    vision: spec.vision,
    video: spec.video && adapter.transmits.video === true,
    ...(adapter.transmits.mediaUploadAbove !== undefined
      ? { videoUploadAbove: adapter.transmits.mediaUploadAbove }
      : {}),
    ...(imagesRejected ? { imagesRejected: true as const } : {}),
    resources: new Map(),
    state: new Map(),
    signal: abort.signal,
    sink: new RuntimeSink(store, content, id),
    requestPermission: async () => ({ allowed: false, reason: '重放不执行工具' }),
  })
  const loop = new AgentLoop({
    adapter: recording,
    registry,
    systemPrompt,
    makeToolContext,
    persist,
    compaction,
  })
  try {
    for await (const ev of loop.run({
      runId,
      history,
      ...(effort ? { effort } : {}),
      cacheKey: p.conversationId,
      signal: abort.signal,
      ...(bound ? { userMessageId: bound } : {}),
      ...(imagesRejected ? { imagesRejected: true as const } : {}),
    })) {
      if (ev.type === 'run.error' && !String(ev.message).includes(STOP)) failure = ev.message
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!message.includes(STOP)) failure = message
  } finally {
    clearTimeout(timer)
  }
  const memoryTool = registry.list().find((s) => s.name === 'write_memory')
  return {
    id: p.id,
    sample,
    tools: calls.map((c) => c.name),
    writes: calls
      .filter((c) => c.name === 'write_memory')
      .map((c) => ({
        key: String(c.arguments.key ?? ''),
        scope: String(c.arguments.scope ?? 'project'),
        content: String(c.arguments.content ?? ''),
      })),
    text: text.replace(/\s+/g, ' ').slice(0, 300),
    error: calls.length || text ? null : failure,
    definition: Bun.hash(`${memoryTool?.description ?? ''}${NL}${systemPrompt}`).toString(16),
  }
}

async function runAll(points: Point[], out: string, samples: number, parallel: number) {
  const dir = join(ROOT, out)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  const ledger = join(dir, 'ledger.sqlite3')
  copyFileSync(LEDGER, ledger)
  const store = new Store({ path: ledger })
  const content = new ContentStore(CONTENT)
  const config = await loadConfig()
  const results = join(dir, 'results.jsonl')

  const groups = new Map<string, Point[]>()
  for (const p of points) groups.set(p.conversationId, [...(groups.get(p.conversationId) ?? []), p])
  const queue = [...groups.values()].map((g) => g.sort((a, b) => b.at - a.at))
  let done = 0
  const worker = async () => {
    for (let g = queue.shift(); g; g = queue.shift()) {
      for (const p of g) {
        truncate(store, p)
        for (let s = 1; s <= samples; s++) {
          const r = await replay(store, content, config, p, s).catch(
            (err): Result => ({
              id: p.id,
              sample: s,
              tools: [],
              writes: [],
              text: '',
              error: err instanceof Error ? err.message : String(err),
              definition: '',
            }),
          )
          await appendFile(results, `${JSON.stringify(r)}${NL}`)
          done++
          const wrote = r.writes.map((w) => `${w.key}：${firstLine(w.content)}`).join(' | ')
          line(
            `  [${done}] ${p.kind} ${p.id} #${s} ${r.error ? `错误：${r.error.slice(0, 120)}` : wrote ? `写入 ${wrote.slice(0, 160)}` : `未写入（${r.tools.join(',') || '回复'}）`}`,
          )
        }
      }
    }
  }
  await Promise.all(Array.from({ length: parallel }, worker))
  store.close()
  line(`结果：${results}`)
}

function score(out: string, points: Point[]): void {
  const labels = JSON.parse(readFileSync(LABELS, 'utf8')) as Record<string, Label>
  const rows = readFileSync(join(ROOT, out, 'results.jsonl'), 'utf8')
    .split(NL)
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Result)
  const byKind = new Map<string, { pass: number; total: number }>()
  const misses: string[] = []
  for (const r of rows) {
    const p = points.find((x) => x.id === r.id)
    const label = labels[r.id]
    if (!p || !label || r.error) continue
    const wrote = r.writes.length > 0
    const ok = label.expect === 'either' || (label.expect === 'write') === wrote
    const key = `${p.kind === 'write' ? '写入点' : p.kind === 'control' ? '对照' : '纠正点'} · ${
      { write: '应写', none: '不应写', either: '均可' }[label.expect]
    }`
    const cell = byKind.get(key) ?? { pass: 0, total: 0 }
    cell.total++
    if (wrote) cell.pass++
    byKind.set(key, cell)
    if (!ok || wrote || label.expect === 'write') {
      misses.push(
        `${ok ? '　' : '✗'} ${p.kind} ${r.id} #${r.sample} [${label.expect}：${label.rule ?? ''}] ${wrote ? r.writes.map((w) => `${w.key}：${firstLine(w.content)}`).join(' | ') : '未写入'}`,
      )
    }
  }
  for (const [k, v] of [...byKind].sort()) line(`  ${k}：写入 ${v.pass}/${v.total}`)
  const errors = rows.filter((r) => r.error).length
  line(`  请求失败：${errors}`)
  line(`  定义指纹：${[...new Set(rows.map((r) => r.definition).filter(Boolean))].join(', ')}`)
  for (const m of misses) line(m)
}

async function main(): Promise<void> {
  await mkdir(ROOT, { recursive: true })
  snapshot()
  const db = new Database(LEDGER, { readonly: true })
  const all = selectPoints(db)
  db.close()
  const only = arg('only')?.split(',')
  const points = only ? all.filter((p) => only.includes(p.id)) : all

  if (process.argv.includes('--list')) {
    for (const p of points) {
      line(
        `${p.id}	${p.kind}	${p.model}	${p.workspace.split(/[\\/]/).pop()}	${p.manifest}	${p.message.slice(0, 80)}${p.original ? `	→ ${p.original.slice(0, 120)}` : ''}`,
      )
    }
    line(`共 ${points.length} 个决策点`)
    return
  }
  const scoreOf = arg('score')
  if (scoreOf) return score(scoreOf, all)
  const out = arg('out')
  if (!out) throw new Error('用法见文件头：--list、--out=<名称> 或 --score=<名称>')
  await runAll(points, out, Number(arg('samples') ?? 1), Number(arg('parallel') ?? 4))
}

await main()
