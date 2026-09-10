/**
 * shell 的写入贯通到变更页。
 *
 * 覆盖范围：`tools/shell.ts` 的 `run_command` 输出（真的起 shell，不打桩）、
 * `store/repos.ts` 的 `listConversationChangesPage` 归轮与分页、
 * `api/conversations.ts` 的 `GET /api/conversations/:id/changes`。
 * 观察器自身的忽略判定由 `tools/workspace-watch.test.ts` 覆盖；
 * 外部 CLI 与内置子 agent 那两条来源由 `delegate.test.ts` 覆盖。
 *
 * shell 与外部 CLI 的写入没有精确明细：路径与变更类型是观察器能知道的全部，
 * 改过的与删掉的不带行数。并行执行时几个窗口叠着开，归属按最早那个算，是估算。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ToolContext, ToolRegistry } from '@qywork/agent'
import type {
  ConversationChangesPageResponse,
  ConversationId,
  FileChange,
  WorkspaceId,
} from '@qywork/core'
import {
  appendMessage,
  appendStep,
  createConversation,
  createRun,
  finishRun,
  Store,
  upsertWorkspace,
} from '@qywork/store'
import { registerBuiltinTools } from '@qywork/tools'
import { type ApiDeps, handleApi } from './api/index.ts'

let dir = ''
let binDir = ''
let script = ''
let store: Store
let workspaceId = ''

const registry = new ToolRegistry()
registerBuiltinTools(registry)
/** `run_command` 按能力注册：这台机器上一个 shell 都没有时它不存在，本测试也就跑不了。 */
const runCommand = registry.get('run_command')

/** 命令交给真的 shell 执行，写盘那几步由一个 bun 脚本做：bash 与 PowerShell 的语法不同。 */
const command = (tag: string) => `bun "${script}" ${tag}`

const SCRIPT = `
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()
const put = async (rel, body) => {
  const abs = join(root, rel)
  await mkdir(join(abs, '..'), { recursive: true })
  await writeFile(abs, body)
}

if (process.argv[2] === 'one') {
  await put('src/a.ts', 'export const a = 1\\n')
  await put('.github/workflows/ci.yml', 'name: ci\\n')
  await put('.editorconfig', 'root = true\\n')
  await put('tracked.ts', 'export const t = 2\\n')
  await rm(join(root, 'doomed.ts'))
  await put('.profile-cache/state.bin', 'cache')
  await put('.tmp/junk.txt', 'junk')
} else if (process.argv[2] === 'two') {
  await put('docs/b.md', '# b\\n')
} else {
  await put('notes/c.md', '# c\\n')
}
`

function deps(): ApiDeps {
  return {
    store,
    config: { active: { provider: 'p', model: 'm' }, providers: {}, mode: 'auto' },
    runs: { isBusy: () => false },
    bus: { publish: () => {} },
  } as unknown as ApiDeps
}

async function changesPage(
  conversationId: ConversationId,
  query: string,
): Promise<ConversationChangesPageResponse> {
  const path = `/api/conversations/${conversationId}/changes?${query}`
  const res = await handleApi(
    new URL(`http://127.0.0.1${path}`),
    new Request(`http://127.0.0.1${path}`),
    deps(),
  )
  expect(res?.status).toBe(200)
  return (await res?.json()) as ConversationChangesPageResponse
}

/** 跑一条真的命令，把结果按 `run_command` 的账本形状落成一轮。 */
async function turn(conversationId: ConversationId, text: string, tag: string) {
  if (!runCommand) throw new Error('这台机器上 bash / pwsh / powershell 一个都没有，跑不了本测试')
  const outcome = await runCommand.fn({ command: command(tag) }, {
    workspaceRoot: dir,
    emit: () => {},
    sink: null,
  } as unknown as ToolContext)
  expect(outcome.status).toBe('success')

  const message = appendMessage(store, { conversationId, role: 'user', content: text })
  const run = createRun(store, {
    conversationId,
    workspaceId: workspaceId as WorkspaceId,
    model: 'm',
    clientRequestId: `changes-${tag}-${message.id}`,
    userMessageId: message.id,
    messageIdUpperBound: message.id,
    contextSnapshot: [],
  })
  appendStep(store, {
    runId: run.id,
    seq: 1,
    kind: 'tool_action',
    toolName: 'run_command',
    status: 'success',
    payload: {
      kind: 'tool_result',
      args: { command: command(tag) },
      // 落库的规范结果里 `executed` 不是可选的，缺省即真——注册表那一层也是这么补的。
      outcome: { ...outcome, executed: outcome.executed ?? true },
    },
  })
  finishRun(store, run.id, { status: 'done', stopReason: 'completed' })
  return { outcome, messageId: message.id }
}

function shape(changes: FileChange[]): [string, string, boolean][] {
  return changes
    .map((c): [string, string, boolean] => [c.path, c.changeType, typeof c.additions === 'number'])
    .sort((a, b) => a[0].localeCompare(b[0]))
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qywork-changes-'))
  binDir = await mkdtemp(join(tmpdir(), 'qywork-changes-bin-'))
  script = join(binDir, 'change.ts').replaceAll('\\', '/')
  await writeFile(script, SCRIPT)

  const git = (...args: string[]) => {
    const r = Bun.spawnSync(['git', ...args], { cwd: dir })
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}：${r.stderr.toString()}`)
  }
  git('init', '-q', '-b', 'main', '.')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  await writeFile(join(dir, '.gitignore'), '.profile-cache/\n')
  await writeFile(join(dir, 'tracked.ts'), 'export const t = 1\n')
  await writeFile(join(dir, 'doomed.ts'), 'export const d = 1\n')
  git('add', '.gitignore', 'tracked.ts', 'doomed.ts')
  // 让「创建时间在窗口之前」成立：文件系统的时间戳精度以毫秒计。
  await Bun.sleep(20)

  store = new Store({ path: ':memory:' })
  workspaceId = upsertWorkspace(store, dir, 'changes-ws').id
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  await rm(binDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
})

describe('shell 的写入进变更页', () => {
  test('项目点路径进账、被忽略的产物不进；新建 / 修改 / 删除各判其类', async () => {
    const conv = createConversation(store, {
      workspaceId: workspaceId as WorkspaceId,
      provider: 'p',
      model: 'm',
    })
    const { outcome } = await turn(conv.id, '跑一条命令', 'one')

    // 工具结果这一层就得对：账本与变更页都只是把它原样带下去。
    expect(shape(outcome.fileChanges ?? [])).toEqual([
      ['.editorconfig', 'created', true],
      ['.github/workflows/ci.yml', 'created', true],
      ['doomed.ts', 'deleted', false],
      ['src/a.ts', 'created', true],
      ['tracked.ts', 'modified', false],
    ])

    const page = await changesPage(conv.id, 'limit=10')
    expect(page.turns.map((t) => t.text)).toEqual(['跑一条命令'])
    expect(page.turns[0]?.steps.map((s) => [s.toolName, s.via])).toEqual([['run_command', null]])
    expect(shape(page.turns[0]?.steps[0]?.fileChanges ?? [])).toEqual(
      shape(outcome.fileChanges ?? []),
    )
    expect([...page.totals.paths].sort()).toEqual([
      '.editorconfig',
      '.github/workflows/ci.yml',
      'doomed.ts',
      'src/a.ts',
      'tracked.ts',
    ])
    // 改过的与删掉的不带行数，合计只加已知的那几笔。
    expect(page.totals.deletions).toBe(0)
    expect(page.totals.additions).toBeGreaterThan(0)
  })

  test('两轮之间按用户消息分页，游标翻页与合计一致', async () => {
    const conv = createConversation(store, {
      workspaceId: workspaceId as WorkspaceId,
      provider: 'p',
      model: 'm',
    })
    await turn(conv.id, '第一轮', 'two')
    const second = await turn(conv.id, '第二轮', 'three')

    const head = await changesPage(conv.id, 'limit=1')
    expect(head.turns.map((t) => t.text)).toEqual(['第二轮'])
    expect(shape(head.turns[0]?.steps[0]?.fileChanges ?? [])).toEqual([
      ['notes/c.md', 'created', true],
    ])
    expect(head.nextCursor).toBe(second.messageId)

    const rest = await changesPage(conv.id, `limit=1&before=${head.nextCursor}`)
    expect(rest.turns.map((t) => t.text)).toEqual(['第一轮'])
    // 前面没有第三轮了，游标到头。
    expect(rest.nextCursor).toBeNull()
    expect(shape(rest.turns[0]?.steps[0]?.fileChanges ?? [])).toEqual([
      ['docs/b.md', 'created', true],
    ])

    // 合计是整条会话的，与翻到第几页无关。
    expect([...head.totals.paths].sort()).toEqual(['docs/b.md', 'notes/c.md'])
    expect([...rest.totals.paths].sort()).toEqual(['docs/b.md', 'notes/c.md'])
  })
})
