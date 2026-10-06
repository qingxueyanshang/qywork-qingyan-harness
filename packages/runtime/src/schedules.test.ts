/**
 * 全机任务文件的一次性导入。覆盖范围：`schedules.ts`。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConversation, listSchedules, Store, upsertWorkspace } from '@qywork/store'
import { importLegacySchedules } from './schedules.ts'

const ROOT = 'C:/ws/a'
let home = ''
let store: Store
const prevHome = process.env.QYWORK_HOME

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'qywork-sched-import-'))
  process.env.QYWORK_HOME = home
  store = new Store({ path: ':memory:' })
  upsertWorkspace(store, ROOT, 'A')
})

afterEach(() => {
  if (prevHome === undefined) delete process.env.QYWORK_HOME
  else process.env.QYWORK_HOME = prevHome
  store.close()
  rmSync(home, { recursive: true, force: true })
})

const legacy = () => join(home, 'schedules.json')
const imported = () => join(home, 'schedules.json.imported')

function writeLegacy(list: unknown): void {
  writeFileSync(legacy(), JSON.stringify(list, null, 2), 'utf8')
}

/** 旧文件中记录的原始形状。键名是历史事实，不随 `Schedule` 修改。 */
const one = {
  id: 'sch_kept',
  workspaceRoot: ROOT,
  title: '日报',
  prompt: '写日报',
  kind: 'daily' as const,
  atHour: 9,
  atMinute: 30,
  enabled: false,
  createdAt: 1_700_000_000_000,
  lastRunAt: 1_700_000_600_000,
  lastError: '旧文件里留下的报错',
}

describe('导入', () => {
  test('文件不存在时不导入', () => {
    expect(importLegacySchedules(store)).toBe(null)
    expect(listSchedules(store, ROOT, Date.now())).toEqual([])
  })

  test('逐字段导入，随后重命名文件', () => {
    writeLegacy([one])
    expect(importLegacySchedules(store)).toBe(1)

    const s = listSchedules(store, ROOT, Date.now())[0]!
    expect(s.id).toBe('sch_kept')
    expect(s.title).toBe('日报')
    expect(s.prompt).toBe('写日报')
    expect(s.kind).toBe('daily')
    expect(s.atHour).toBe(9)
    expect(s.atMinute).toBe(30)
    expect(s.enabled).toBe(false)
    expect(s.createdAt).toBe(one.createdAt)
    expect(s.lastRunAt).toBe(one.lastRunAt)
    // 文件中的 lastError 不导入：执行结果的唯一权威是关联的 Run。
    expect('lastError' in s).toBe(false)
    expect(s.lastRun).toBe(null)
    // 旧文件没有这一项，导入后仍发送到绑定会话。
    expect(s.newConversation).toBe(false)

    expect(existsSync(legacy())).toBe(false)
    expect(JSON.parse(readFileSync(imported(), 'utf8'))).toEqual([one])
  })

  test('重命名之后再次启动不重复导入', () => {
    writeLegacy([one])
    expect(importLegacySchedules(store)).toBe(1)
    expect(importLegacySchedules(store)).toBe(null)
    expect(listSchedules(store, ROOT, Date.now()).length).toBe(1)
  })

  test('旧文件中的 lastRunConversationId 导入为绑定会话，会话不存在时丢弃该 id', () => {
    const conv = createConversation(store, {
      workspaceId: upsertWorkspace(store, ROOT, 'A').id,
      provider: 'p',
      model: 'm',
      title: '上次那条',
    })
    writeLegacy([
      { ...one, id: 'sch_live', lastRunConversationId: conv.id },
      { ...one, id: 'sch_gone', lastRunConversationId: 'cv_deleted' },
    ])
    expect(importLegacySchedules(store)).toBe(2)

    const rows = listSchedules(store, ROOT, Date.now())
    expect(rows.find((s) => s.id === 'sch_live')?.conversationId).toBe(conv.id)
    expect(rows.find((s) => s.id === 'sch_gone')?.conversationId).toBe(undefined)
  })

  test('损坏的 JSON 抛错并保留原字节，不当作空表继续执行', () => {
    writeFileSync(legacy(), '{ 不是数组', 'utf8')
    expect(() => importLegacySchedules(store)).toThrow('不是合法 JSON')
    expect(readFileSync(legacy(), 'utf8')).toBe('{ 不是数组')
    expect(existsSync(imported())).toBe(false)
  })

  test('重复 id 抛错，不写入任何记录，文件保持原样', () => {
    writeLegacy([one, { ...one, title: '另一条' }])
    expect(() => importLegacySchedules(store)).toThrow('id 重复')
    expect(listSchedules(store, ROOT, Date.now())).toEqual([])
    expect(existsSync(legacy())).toBe(true)
    expect(existsSync(imported())).toBe(false)
  })

  test('非法值抛错并指出出错的字段', () => {
    writeLegacy([{ ...one, atHour: 44 }])
    expect(() => importLegacySchedules(store)).toThrow('小时必须在 0–23')
    expect(listSchedules(store, ROOT, Date.now())).toEqual([])
    expect(existsSync(legacy())).toBe(true)
  })

  test('缺 id 的记录同样中止整份导入', () => {
    const { id: _drop, ...noId } = one
    writeLegacy([noId])
    expect(() => importLegacySchedules(store)).toThrow('id 缺失')
    expect(existsSync(legacy())).toBe(true)
  })
})
