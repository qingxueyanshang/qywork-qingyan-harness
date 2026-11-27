/**
 * 会话临时目录的删除时机。覆盖范围：`temp-files.ts`，以及 `tools` 的 `conversationTempDir`、
 * `officeRunDir` 的路径约定。
 *
 * 锁定「任务是否完成只读取账本与运行表」：待办全部完成且正常结束才删除整个会话目录，
 * 其余情形只删除 Office 目录；仍有后台任务的轮次的 Office 目录保留。
 */

import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConversationId, RunId, StopReason } from '@qywork/core'
import { appendStep, createConversation, createRun, Store, upsertWorkspace } from '@qywork/store'
import { conversationTempDir, officeRunDir } from '@qywork/tools'
import { releaseRunTemp, removeConversationTemp } from './temp-files.ts'

type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed' }

async function fixture(todos: Todo[] | null) {
  const root = await mkdtemp(join(tmpdir(), 'qywork-temp-files-'))
  const store = new Store({ path: ':memory:' })
  const ws = upsertWorkspace(store, root, 'ws')
  const conversation = (extra: Record<string, unknown>) =>
    createConversation(store, {
      workspaceId: ws.id,
      provider: 'p',
      model: 'm',
      title: 't',
      ...extra,
    }).id as ConversationId
  const parent = conversation({})
  const child = conversation({ source: 'temp', parentConversationId: parent })
  const run = createRun(store, {
    conversationId: parent,
    workspaceId: ws.id,
    provider: 'p',
    model: 'm',
    clientRequestId: `temp-${parent}`,
    userMessageId: null,
    messageIdUpperBound: null,
    contextSnapshot: [],
  }).id as RunId
  if (todos) {
    appendStep(store, {
      runId: run,
      seq: 1,
      kind: 'tool_action',
      toolName: 'write_todos',
      status: 'success',
      payload: { kind: 'tool_result', args: { todos } } as never,
    })
  }
  for (const id of [parent, child]) {
    await mkdir(conversationTempDir(root, id), { recursive: true })
    await writeFile(join(conversationTempDir(root, id), 'crop.png'), 'x')
  }
  await mkdir(officeRunDir(root, parent, run), { recursive: true })
  await writeFile(join(officeRunDir(root, parent, run), 'candidate.pptx'), 'x')
  return { root, store, parent, child, run }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

function release(
  f: Fixture,
  over: Partial<{
    stopReason: StopReason
    topLevel: boolean
    backgroundRunning: boolean
    heldRuns: string[]
  }> = {},
) {
  return releaseRunTemp({
    store: f.store,
    workspaceRoot: f.root,
    conversationId: f.parent,
    runId: f.run,
    stopReason: 'completed',
    topLevel: true,
    backgroundRunning: false,
    heldRuns: [],
    ...over,
  })
}

const done: Todo[] = [
  { content: '拆层', status: 'completed' },
  { content: '交付', status: 'completed' },
]

describe('一轮结束时的临时目录', () => {
  test('待办全部完成且正常结束：删除本会话与子会话的临时目录', async () => {
    const f = await fixture(done)
    await release(f)
    expect(existsSync(conversationTempDir(f.root, f.parent))).toBe(false)
    expect(existsSync(conversationTempDir(f.root, f.child))).toBe(false)
  })

  test.each([
    ['待办未全部完成', [{ content: '交付', status: 'in_progress' }] as Todo[], {}],
    ['本轮没有待办', null, {}],
    ['等待用户回复', done, { stopReason: 'awaiting_user' as const }],
    ['被中断', done, { stopReason: 'user_interrupt' as const }],
    ['仍有子 agent 或后台任务在运行', done, { backgroundRunning: true }],
    ['子会话的轮次', done, { topLevel: false }],
  ])('%s：只删除本轮的 Office 目录，会话临时目录保留', async (_, todos, over) => {
    const f = await fixture(todos)
    await release(f, over)
    expect(existsSync(officeRunDir(f.root, f.parent, f.run))).toBe(false)
    expect(existsSync(join(conversationTempDir(f.root, f.parent), 'crop.png'))).toBe(true)
    expect(existsSync(join(conversationTempDir(f.root, f.child), 'crop.png'))).toBe(true)
  })

  /**
   * 原始失败形状：本轮转入后台的 write_office 仍在本轮的 Office 目录中执行，本轮结束时目录被移走，任务以 ENOENT 失败。
   * 另一形状：有任何后台任务时整体跳过，以 background 启动的服务运行期间每一轮的 Office 目录都留在磁盘上。
   */
  test('仍有后台任务的轮次保留 Office 目录；其余轮次（含此前保留、任务已结束的）删除', async () => {
    const f = await fixture(done)
    const older = 'rn_older' as RunId
    await mkdir(officeRunDir(f.root, f.parent, older), { recursive: true })
    await writeFile(join(officeRunDir(f.root, f.parent, older), 'cache.png'), 'x')

    await release(f, { backgroundRunning: true, heldRuns: [f.run, older] })
    expect(existsSync(join(officeRunDir(f.root, f.parent, f.run), 'candidate.pptx'))).toBe(true)
    expect(existsSync(join(officeRunDir(f.root, f.parent, older), 'cache.png'))).toBe(true)

    await release(f, { backgroundRunning: true, heldRuns: [f.run] })
    expect(existsSync(officeRunDir(f.root, f.parent, older))).toBe(false)
    expect(existsSync(join(officeRunDir(f.root, f.parent, f.run), 'candidate.pptx'))).toBe(true)
    expect(existsSync(join(conversationTempDir(f.root, f.parent), 'crop.png'))).toBe(true)
  })
})

describe('删除会话时的临时目录', () => {
  test('同时删除子会话的临时目录', async () => {
    const f = await fixture(null)
    await removeConversationTemp(f.store, f.root, f.parent)
    expect(existsSync(conversationTempDir(f.root, f.parent))).toBe(false)
    expect(existsSync(conversationTempDir(f.root, f.child))).toBe(false)
  })
})
