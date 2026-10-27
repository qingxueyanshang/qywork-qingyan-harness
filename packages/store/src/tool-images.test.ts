/**
 * 覆盖 `tool-images.ts`（写入与读取两处转换）、`settleToolStep` 的图像写入，以及迁移 70 与 72。
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunId, StepId } from '@qywork/core'
import { ContentStore, contentPathFor } from './content.ts'
import { Store } from './db.ts'
import {
  appendStep,
  createConversation,
  createRun,
  deleteConversation,
  listConversationHistoryPage,
  listSteps,
  settleToolStep,
  upsertWorkspace,
} from './repos.ts'
import { referencedContentHashes } from './resources.ts'
import { loadToolImages } from './tool-images.ts'

/** 一张约 300 KB 的图像（标准 base64），大小与审图任务中一张缩放后的渲染页相当。 */
const PAGE_BYTES = 225_000
const PAGE = Buffer.alloc(PAGE_BYTES, 7).toString('base64')
const OTHER = Buffer.from('another image').toString('base64')

function fixture(store: Store) {
  const ws = upsertWorkspace(store, '/tmp/ws-images', 'ws')
  const cv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
  const run = createRun(store, {
    conversationId: cv.id,
    workspaceId: ws.id,
    model: 'm',
    clientRequestId: 'images',
    userMessageId: null,
    messageIdUpperBound: null,
    contextSnapshot: [],
  })
  let seq = 0
  const read = (
    images: { data: string; mime: string; [k: string]: unknown }[],
    content?: ContentStore,
  ) => {
    seq += 1
    const step = appendStep(store, {
      runId: run.id,
      seq,
      kind: 'tool_action',
      toolName: 'read_file',
      toolCallId: `call_${seq}`,
      providerBatchId: `bt_${seq}`,
      callIndex: 0,
      status: 'running',
    })
    settleToolStep(
      store,
      step.id,
      'success',
      {
        kind: 'tool_result',
        args: { path: `page-${seq}.png` },
        outcome: { status: 'success', executed: true, message: '读取（图片）', data: { images } },
      } as never,
      undefined,
      content,
    )
    return step.id
  }
  return { cv, run, read }
}

function imagesOf(store: Store, runId: RunId, stepId: StepId): unknown {
  const step = listSteps(store, runId).find((s) => s.id === stepId)
  return step?.payload?.kind === 'tool_result'
    ? (step.payload.outcome.data as { images: unknown }).images
    : null
}

describe('工具结果的图像写入正文库，账本只存引用', () => {
  /**
   * 原始失败形状：同一张图每被读取或取回一次，账本就存一份 base64，历史接口原样返回这些字节。
   */
  test('同一张图读取三次：正文只存一份，payload 与历史页不含字节，读取后逐字节还原', () => {
    const store = new Store({ path: ':memory:' })
    const content = new ContentStore(':memory:')
    const { cv, run, read } = fixture(store)
    const ids = [1, 2, 3].map(() => read([{ data: PAGE, mime: 'image/jpeg' }], content))

    for (const id of ids) {
      expect(imagesOf(store, run.id, id)).toEqual([
        { mime: 'image/jpeg', resourceId: expect.any(String), bytes: PAGE_BYTES, size: null },
      ])
    }
    expect(
      content.db.query<{ n: number }, []>('SELECT count(*) n FROM content_blobs').get()?.n,
    ).toBe(1)
    const rows = store.db
      .query<{ step_id: string; source_type: string }, []>(
        'SELECT step_id, source_type FROM intermediate_resources ORDER BY created_at',
      )
      .all()
    expect(rows).toEqual(ids.map((id) => ({ step_id: id, source_type: 'tool_image' })))

    const page = JSON.stringify(listConversationHistoryPage(store, cv.id, { limit: 30 }))
    expect(page.includes(PAGE)).toBe(false)
    expect(page.length).toBeLessThan(10_000)

    const loaded = loadToolImages(store, content, listSteps(store, run.id))
    for (const step of loaded) {
      const payload = step.payload
      expect(payload?.kind === 'tool_result' && payload.outcome.data).toEqual({
        images: [{ mime: 'image/jpeg', data: PAGE }],
      })
    }
  })

  test('多张图保持顺序，图像上的其他字段原样保留', () => {
    const store = new Store({ path: ':memory:' })
    const content = new ContentStore(':memory:')
    const { run, read } = fixture(store)
    const id = read(
      [
        { data: OTHER, mime: 'image/png', name: 'a' },
        { data: PAGE, mime: 'image/jpeg' },
      ],
      content,
    )
    const [step] = loadToolImages(
      store,
      content,
      listSteps(store, run.id).filter((s) => s.id === id),
    )
    const payload = step?.payload
    expect(payload?.kind === 'tool_result' && payload.outcome.data).toEqual({
      images: [
        { mime: 'image/png', name: 'a', data: OTHER },
        { mime: 'image/jpeg', data: PAGE },
      ],
    })
  })

  test('没有正文库时拒绝写入带图像字节的结果，执行记录保持原状', () => {
    const store = new Store({ path: ':memory:' })
    const { run, read } = fixture(store)
    expect(() => read([{ data: PAGE, mime: 'image/jpeg' }])).toThrow('写入账本需要正文库')
    const [step] = listSteps(store, run.id)
    expect(step?.status).toBe('running')
    expect(JSON.stringify(step?.payload ?? null).includes(PAGE)).toBe(false)
  })

  test('正文缺失时不还原该图，imagesMissing 记下张数', () => {
    const store = new Store({ path: ':memory:' })
    const content = new ContentStore(':memory:')
    const { run, read } = fixture(store)
    read([{ data: PAGE, mime: 'image/jpeg' }], content)
    content.db.exec('DELETE FROM content_blobs')
    const [step] = loadToolImages(store, content, listSteps(store, run.id))
    const payload = step?.payload
    expect(payload?.kind === 'tool_result' && payload.outcome.data).toEqual({
      images: [],
      imagesMissing: 1,
    })
  })

  test('删除会话后引用随之删除，回收删除对应正文', () => {
    const store = new Store({ path: ':memory:' })
    const content = new ContentStore(':memory:')
    const { cv, read } = fixture(store)
    read([{ data: PAGE, mime: 'image/jpeg' }], content)
    expect(referencedContentHashes(store)).toHaveLength(1)
    deleteConversation(store, cv.id)
    expect(referencedContentHashes(store)).toEqual([])
    expect(content.collectGarbage(referencedContentHashes(store))).toEqual({ removed: 1 })
  })
})

describe('迁移 70：已有执行记录中的图像字节移入正文库', () => {
  test('payload 改为引用、正文写入同目录的正文库、读取后逐字节相同，并收回文件空间', () => {
    const dir = mkdtempSync(join(tmpdir(), 'migration-70-'))
    const path = join(dir, 'qywork.sqlite3')
    try {
      // 先建出完整结构，再写入旧形状的行并撤销迁移 70 的登记，模拟升级前的账本。
      const setup = new Store({ path })
      const { run } = fixture(setup)
      const old = Array.from({ length: 8 }, (_, i) => {
        const step = appendStep(setup, {
          runId: run.id,
          seq: 100 + i,
          kind: 'tool_action',
          toolName: i % 2 ? 'read_history' : 'read_file',
          toolCallId: `old_${i}`,
          providerBatchId: `old_${i}`,
          callIndex: 0,
          status: 'success',
        })
        setup.db.query('UPDATE steps SET payload = ? WHERE id = ?').run(
          JSON.stringify({
            kind: 'tool_result',
            args: { path: 'page.png' },
            outcome: {
              status: 'success',
              executed: true,
              message: '读取（图片）',
              data: { images: [{ data: PAGE, mime: 'image/jpeg' }] },
            },
          }),
          step.id,
        )
        return step.id
      })
      // 参数正文中含同样字样、但结果没有图像的行不受影响。
      const textual = appendStep(setup, {
        runId: run.id,
        seq: 200,
        kind: 'tool_action',
        toolName: 'write_file',
        toolCallId: 'text',
        providerBatchId: 'text',
        callIndex: 0,
        status: 'success',
        payload: {
          kind: 'tool_result',
          args: { path: 'a.json', content: '{"images":[{"data":"x"}]}' },
          outcome: { status: 'success', executed: true, message: '已写入' },
        } as never,
      })
      const before = listSteps(setup, run.id)
      setup.db.exec('DELETE FROM _migrations WHERE id = 70')
      setup.close()
      const sizeBefore = statSync(path).size

      const store = new Store({ path })
      const content = new ContentStore(contentPathFor(path))
      try {
        // 打开账本时不执行；逐批执行直至完成，完成后登记。
        expect(imagesOf(store, run.id, old[0]!)).toEqual([{ data: PAGE, mime: 'image/jpeg' }])
        let batches = 0
        while (store.migrateInBackground(content)) batches++
        expect(batches).toBeGreaterThan(0)
        expect(store.db.query('SELECT 1 FROM _migrations WHERE id = 70').get()).toBeTruthy()
        expect(store.migrateInBackground(content)).toBe(false)
        for (const id of old) {
          expect(imagesOf(store, run.id, id)).toEqual([
            { mime: 'image/jpeg', resourceId: expect.any(String), bytes: PAGE_BYTES, size: null },
          ])
        }
        expect(listSteps(store, run.id).find((s) => s.id === textual.id)).toEqual(
          before.find((s) => s.id === textual.id),
        )
        expect(loadToolImages(store, content, listSteps(store, run.id))).toEqual(before)
        expect(
          content.db.query<{ n: number }, []>('SELECT count(*) n FROM content_blobs').get()?.n,
        ).toBe(1)
        expect(statSync(path).size).toBeLessThan(sizeBefore - old.length * PAGE.length * 0.9)
      } finally {
        content.close()
        store.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('打开账本时不执行；没有待迁移的行时每个分批迁移第一批即完成并登记', () => {
    const store = new Store({ path: ':memory:' })
    const done = (id: number) => !!store.db.query('SELECT 1 FROM _migrations WHERE id = ?').get(id)
    expect([done(70), done(72)]).toEqual([false, false])
    const content = new ContentStore(':memory:')
    expect(store.migrateInBackground(content)).toBe(true)
    expect(store.migrateInBackground(content)).toBe(false)
    expect([done(70), done(72)]).toEqual([true, true])
  })
})

describe('迁移 72：工具图片的引用补上像素宽高', () => {
  /** 只有文件头合法的 1440×900 PNG，其后是填充字节。 */
  function png(): string {
    const b = Buffer.alloc(30_000, 9)
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 0)
    b.writeUInt32BE(1440, 16)
    b.writeUInt32BE(900, 20)
    return b.toString('base64')
  }

  test('入库时记下尺寸；没有尺寸的旧引用由迁移补齐，文件头无法识别的记为 null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'migration-72-'))
    const path = join(dir, 'qywork.sqlite3')
    try {
      const setup = new Store({ path })
      const setupContent = new ContentStore(contentPathFor(path))
      const { run, read } = fixture(setup)
      const shot = read([{ data: png(), mime: 'image/png' }], setupContent)
      const blank = read([{ data: OTHER, mime: 'image/png' }], setupContent)
      expect(imagesOf(setup, run.id, shot)).toEqual([
        {
          mime: 'image/png',
          resourceId: expect.any(String),
          bytes: 30_000,
          size: { width: 1440, height: 900 },
        },
      ])
      // 去掉尺寸并撤销迁移 72 的登记，模拟升级前写入的引用。
      for (const id of [shot, blank]) {
        const row = setup.db
          .query<{ payload: string }, [string]>('SELECT payload FROM steps WHERE id = ?')
          .get(id)!
        const payload = JSON.parse(row.payload)
        for (const image of payload.outcome.data.images) delete image.size
        setup.db.query('UPDATE steps SET payload = ? WHERE id = ?').run(JSON.stringify(payload), id)
      }
      setup.db.exec('DELETE FROM _migrations WHERE id = 72')
      setupContent.close()
      setup.close()

      const store = new Store({ path })
      const content = new ContentStore(contentPathFor(path))
      try {
        expect(imagesOf(store, run.id, shot)).toEqual([
          { mime: 'image/png', resourceId: expect.any(String), bytes: 30_000 },
        ])
        while (store.migrateInBackground(content)) {}
        expect(store.db.query('SELECT 1 FROM _migrations WHERE id = 72').get()).toBeTruthy()
        expect(imagesOf(store, run.id, shot)).toEqual([
          {
            mime: 'image/png',
            resourceId: expect.any(String),
            bytes: 30_000,
            size: { width: 1440, height: 900 },
          },
        ])
        expect(imagesOf(store, run.id, blank)).toEqual([
          { mime: 'image/png', resourceId: expect.any(String), bytes: 13, size: null },
        ])
      } finally {
        content.close()
        store.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
