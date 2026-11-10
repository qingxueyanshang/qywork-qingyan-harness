/**
 * 云端技能的完整链路：`read_file` 读取 `SKILL.md` → 按行段读取 → 请求中出现标记块 → 网关替换 → 压缩收纳后标记被移除；
 * 会话中途权益被取消时的终态；含标记的请求被容量拒绝后的恢复。
 *
 * 覆盖范围：`cloud/skills/port.ts`、`runtime/session.ts` 的云端技能通道、`tools/cloud-skills/source.ts`，
 * 以及经真实 `Session`、真实 Chat Completions 适配器、真实 `Store` 与 `RuntimeCompaction` 的请求装配、
 * 错误分类（`ai/errors.ts` 的 `skill_rejected`）与容量恢复（`agent/loop/compact.ts` 的 `recoverFromOverflow`）。
 * 云端由 `fake-cloud.test-helper.ts` 在本进程内提供，模型的回复由测试按请求给出。
 *
 * 本机不持有技能原文：每个场景结束后逐字节检查账本、正文库与日志中没有技能文件的内容。
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSkillMarker, SKILL_MARKER_PREFIX } from '@qywork/ai'
import type { AgentEvent, ConversationId } from '@qywork/core'
import { formatLogLine, setLogSink } from '@qywork/core'
import { type QyConfig, Session } from '@qywork/runtime'
import { ContentStore, listProviderRequests, listRuns, Store } from '@qywork/store'
import { CLOUD_PROVIDER } from '../account.ts'
import {
  type FakeCloud,
  lastToolResult,
  startFakeCloud,
  textReply,
  toolCallReply,
} from './fake-cloud.test-helper.ts'
import { cloudSkillPort } from './port.ts'

const PKG = 'flow-demo'
const KEY = 'qyd_device'
const MODEL = 'claude-opus-5-5'
const SKILL_PATH = `cloud-skill://${PKG}/SKILL.md`
const BIG_PATH = `cloud-skill://${PKG}/references/big.md`
const BIG_LINES = 2000

/** 技能文件的内容。各行都含受保护的短语，检查本机存储时逐个查找。 */
const SKILL_MD =
  '---\nname: 短剧流程\ndescription: 按步骤生成短剧\n---\n\n分镜脚本必须保留旁白原文。\n先读取 references/big.md 再开始。\n'
const BIG = Array.from(
  { length: BIG_LINES },
  (_, i) => `第 ${i + 1} 步：剪辑镜头并核对字幕，确认节奏 ${i + 1}。`,
).join('\n')
const PROTECTED = ['分镜脚本必须保留旁白原文', '剪辑镜头并核对字幕']

let cloud: FakeCloud
let dir: string
let store: Store
let content: ContentStore
/** 同一会话的各轮使用同一个工作区。 */
let workspaceRoot: string
const logs: string[] = []
let conversationId: ConversationId | undefined

beforeAll(async () => {
  setLogSink((record) => logs.push(formatLogLine(record)))
  cloud = startFakeCloud({
    key: KEY,
    account: 'user-1',
    signingKey: new Uint8Array(32).fill(5),
    packages: { [PKG]: { 'SKILL.md': SKILL_MD, 'references/big.md': BIG } },
  })
  dir = await mkdtemp(join(process.env.QYWORK_TEST_TEMP ?? tmpdir(), 'cloud-skill-e2e-'))
  store = new Store({ path: join(dir, 'ledger.sqlite3') })
  content = new ContentStore(join(dir, 'content.sqlite3'))
  workspaceRoot = await mkdtemp(join(dir, 'ws-'))
})

afterAll(() => {
  setLogSink(null)
  cloud.stop()
})

function config(): QyConfig {
  return {
    active: { provider: CLOUD_PROVIDER, model: MODEL },
    providers: {
      [CLOUD_PROVIDER]: {
        kind: 'openai_chat_completions',
        baseUrl: cloud.origin,
        apiKey: KEY,
        models: { [MODEL]: {} },
      },
    },
    // 小窗口使一份参考资料需要多段读完，并触发收纳。
    catalog: { [`${MODEL}|openai_chat_completions`]: { contextWindow: 32_000 } },
    // 不在工作区中创建 Python 环境：本测试不运行命令。
    officePython: join(dir, 'no-python.exe'),
  }
}

async function ask(prompt: string): Promise<AgentEvent[]> {
  const live = config()
  const session = new Session({
    content,
    store,
    config: live,
    workspaceRoot,
    signal: new AbortController().signal,
    allowedTools: ['read_file', 'list_dir', 'glob', 'grep'],
    cloudSkills: cloudSkillPort({
      config: live,
      origin: cloud.origin,
      packages: [{ package: PKG }],
    }),
  })
  const events: AgentEvent[] = []
  try {
    for await (const ev of session.ask(prompt, conversationId)) {
      events.push(ev)
      if (ev.type === 'run.started') conversationId = ev.conversationId as ConversationId
    }
  } finally {
    await session.dispose()
  }
  return events
}

const isSummary = (body: Record<string, unknown>) => JSON.stringify(body).includes('交接摘要')

/** 请求体中的标记行（原文）。 */
function markersIn(raw: string): string[] {
  const body = JSON.parse(raw) as { messages: { content: unknown }[] }
  return body.messages.flatMap((m) => {
    const parts =
      typeof m.content === 'string'
        ? [m.content]
        : Array.isArray(m.content)
          ? (m.content as { text?: string }[]).map((p) => p.text ?? '')
          : []
    return parts.flatMap((t) => t.split('\n')).filter((l) => l.startsWith(SKILL_MARKER_PREFIX))
  })
}

/** 账本、正文库与日志中不含技能文件的内容。 */
function expectNoProtectedText(): void {
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  content.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const local = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => readFileSync(join(dir, e.name)))
  for (const phrase of PROTECTED) {
    const needle = Buffer.from(phrase)
    expect(local.some((bytes) => bytes.includes(needle))).toBe(false)
    expect(logs.some((line) => line.includes(phrase))).toBe(false)
  }
}

test('read_file 读取 SKILL.md、按行段读取、网关替换与收纳后移除标记', async () => {
  let reads = 0
  cloud.respond = (body) => {
    if (isSummary(body)) return textReply('摘要：已读取技能主文档与参考资料。')
    const result = lastToolResult(body)
    if (!result) return toolCallReply('c_skill', 'read_file', { path: SKILL_PATH })
    if (result.totalLines !== BIG_LINES) {
      return toolCallReply('c_read_0', 'read_file', { path: BIG_PATH })
    }
    const next = result.nextOffset
    if (typeof next === 'number' && reads < 3) {
      reads++
      return toolCallReply(`c_read_${reads}`, 'read_file', { path: BIG_PATH, offset: next })
    }
    return textReply('已读完。')
  }

  const events = await ask('按短剧流程处理')
  expect(events.filter((e) => e.type === 'run.error')).toEqual([])
  expect(events.find((e) => e.type === 'run.finished')).toMatchObject({ status: 'done' })

  const turns = cloud.received.filter((raw) => !raw.includes('交接摘要'))
  // 第一次请求：云端技能不进入技能索引，请求中没有任何技能内容。
  expect(turns[0]).not.toContain('按步骤生成短剧')
  expect(markersIn(turns[0]!)).toEqual([])

  // read_file 读取 SKILL.md 之后：主文档以独立的标记块发送，网关替换为原文。
  const [skillMarker] = markersIn(turns[1]!)
  expect(parseSkillMarker(skillMarker ?? '')).toMatchObject({ pkg: PKG, path: 'SKILL.md' })
  for (const raw of cloud.received) {
    for (const phrase of PROTECTED) expect(raw).not.toContain(phrase)
  }
  const forwardedTurns = cloud.forwarded.filter((raw) => !raw.includes('交接摘要'))
  expect(forwardedTurns[1]).toContain(PROTECTED[0])
  expect(markersIn(forwardedTurns[1]!)).toEqual([])

  // 参考资料超过单次投递上限，按行段分多次读取；每段的标记是独立的一行。
  const bigMarkers = cloud.received
    .flatMap(markersIn)
    .map((m) => parseSkillMarker(m)!)
    .filter((m) => m.path === 'references/big.md')
  const firstSegment = bigMarkers.find((m) => m.start === 1)!
  expect(firstSegment.end).toBeLessThan(BIG_LINES)
  expect(bigMarkers.some((m) => m.start === firstSegment.end + 1)).toBe(true)

  // 读取第二段之前收纳了第一段：之后的请求不再含第一段的标记，信封注明正文已移除。
  const firstLine = markersIn(turns[2]!).find((m) => parseSkillMarker(m)?.start === 1)!
  const after = turns.findIndex((raw, i) => i > 2 && !raw.includes(firstLine))
  expect(after).toBeGreaterThan(2)
  expect(turns[after]).toContain('\\"result_omitted\\":true')
  expect(markersIn(turns[after]!).length).toBeGreaterThan(0)

  expectNoProtectedText()
}, 60_000)

test('会话中途权益被取消：本轮以 skill_rejected 结束，不重发，记录中只有网关的说明', async () => {
  cloud.granted.delete(PKG)
  const before = cloud.received.length
  try {
    const events = await ask('继续')
    const message = `HTTP 403 禁止访问：未获得技能包的使用权益：${PKG}`
    expect(events.filter((e) => e.type === 'run.error')).toEqual([
      expect.objectContaining({ code: 'skill_rejected', message }),
    ])
    expect(cloud.received.length).toBe(before + 1)
    const run = listRuns(store, conversationId!).at(-1)!
    expect([run.errorCode, run.errorMessage]).toEqual(['skill_rejected', message])
    const rows = listProviderRequests(store, run.id)
    expect(rows.map((r) => [r.status, r.errorMessage, r.diagnostic?.retry.decision])).toEqual([
      ['rejected', message, 'not_retryable'],
    ])
  } finally {
    cloud.granted.add(PKG)
  }
  expectNoProtectedText()
}, 60_000)

test('含标记的请求被容量拒绝后压缩一次再重发，重发的请求中较早的标记已移除', async () => {
  cloud.respond = (body) =>
    isSummary(body) ? textReply('摘要：已读取技能主文档与参考资料。') : textReply('继续完成。')
  cloud.rejectNext = Response.json(
    {
      type: 'error',
      error: {
        type: 'context_length_exceeded',
        code: 'context_length_exceeded',
        message:
          "This model's maximum context length is 32000 tokens. However, your messages resulted in 40000 tokens.",
      },
    },
    { status: 400 },
  )
  const before = cloud.received.length
  const events = await ask('接着做')
  expect(events.filter((e) => e.type === 'run.error')).toEqual([])
  expect(events.find((e) => e.type === 'run.finished')).toMatchObject({ status: 'done' })

  const sent = cloud.received.slice(before).filter((raw) => !raw.includes('交接摘要'))
  expect(sent).toHaveLength(2)
  const [rejected, resent] = sent.map(markersIn)
  expect(rejected!.length).toBeGreaterThan(0)
  expect(resent!.length).toBeLessThan(rejected!.length)
  expect(markersIn(cloud.forwarded.at(-1)!)).toEqual([])

  const run = listRuns(store, conversationId!).at(-1)!
  const decisions = listProviderRequests(store, run.id).map((r) => r.diagnostic?.retry.decision)
  expect(decisions).toContain('context_compaction')
  expectNoProtectedText()
}, 60_000)
