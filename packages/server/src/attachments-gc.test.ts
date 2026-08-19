/**
 * 附件回收的口径。覆盖 `attachments-gc.ts`。
 *
 * 判据是**有没有被消息引用**，不是有多久。按时间清理会把三个月前那条消息里
 * 的图删掉，而历史投影仍然要把它读回请求里——那才是真正的数据丢失。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendMessage, createConversation, Store, upsertWorkspace } from '@qywork/store'
import { sweepAttachments } from './attachments-gc.ts'

const DIR = '.qy/attachments'
let ws = ''
let store: Store

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'qywork-gc-'))
  await mkdir(join(ws, DIR), { recursive: true })
  store = new Store({ path: ':memory:' })
})

afterEach(async () => {
  store.close()
  await rm(ws, { recursive: true, force: true }).catch(() => {})
})

async function put(name: string) {
  await writeFile(join(ws, DIR, name), 'x'.repeat(100))
}

describe('附件回收', () => {
  test('被引用的留下，没被引用的删掉', async () => {
    await put('keep.png')
    await put('orphan.png')
    // 目录自己的 .gitignore 不是附件——删了它，下次粘的图就会进版本控制。
    await writeFile(join(ws, DIR, '.gitignore'), '*\n')

    const w = upsertWorkspace(store, ws, 'ws')
    const conv = createConversation(store, {
      workspaceId: w.id as never,
      provider: 'p',
      model: 'm',
      title: 't',
    })
    appendMessage(store, {
      conversationId: conv.id,
      role: 'user',
      content: '看这张图',
      attachments: [
        { type: 'image', name: 'keep.png', mime: 'image/png', size: 100, path: `${DIR}/keep.png` },
      ],
    })

    const r = await sweepAttachments(store, ws)
    expect(r.removed).toBe(1)

    const left = (await readdir(join(ws, DIR))).sort()
    expect(left).toEqual(['.gitignore', 'keep.png'])
  })

  test('目录不存在时安然返回，不抛', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'qywork-gc-none-'))
    const r = await sweepAttachments(store, empty)
    expect(r).toEqual({ removed: 0, bytes: 0 })
    await rm(empty, { recursive: true, force: true }).catch(() => {})
  })
})
