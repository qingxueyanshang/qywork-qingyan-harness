/**
 * 覆盖 `api/appearance.ts`：个性化接口的读取、保存、恢复默认、背景图片设置、图片直链与
 * `personalization.changed` 广播；界面偏好接口的读取、按字段合并保存、拒绝不合法内容与
 * `preferences.changed` 广播（含 `runtime/appearance/preferences.ts` 的读写）；
 * 宠物库接口的读取、删除、帧直链与 `pets.changed` 广播。
 *
 * 只构造 `bus` 一个依赖：接口不读取项目与配置，其余字段构造后即成为集成测试。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AgentEvent,
  DEFAULT_PERSONALIZATION,
  DEFAULT_UI_PREFERENCES,
  type PersonalizationEntry,
  type UiPreferences,
  type UiPreferencesEntry,
} from '@qywork/core'
import { savePet } from '@qywork/runtime'
import { handleAppearanceApi } from './appearance.ts'
import type { ApiRequestDeps } from './types.ts'

let homeBefore: string | undefined
let events: AgentEvent[] = []

beforeEach(async () => {
  homeBefore = process.env.QYWORK_HOME
  process.env.QYWORK_HOME = await mkdtemp(join(tmpdir(), 'qy-appearance-'))
  events = []
})

afterEach(() => {
  if (homeBefore === undefined) delete process.env.QYWORK_HOME
  else process.env.QYWORK_HOME = homeBefore
})

async function call(path: string, init?: RequestInit): Promise<Response> {
  const url = new URL(`http://x${path}`)
  const deps = { bus: { publish: (e: AgentEvent) => events.push(e) } }
  const res = await handleAppearanceApi(
    url,
    new Request(url.href, init),
    deps as unknown as ApiRequestDeps,
  )
  if (!res) throw new Error(`未处理：${path}`)
  return res
}

const put = (body: unknown): RequestInit => ({ method: 'PUT', body: JSON.stringify(body) })
const read = async (r: Response) => (await r.json()) as PersonalizationEntry

describe('个性化接口', () => {
  test('读取默认值、保存、恢复默认，每次修改都广播', async () => {
    expect((await read(await call('/api/personalization'))).personalization).toEqual(
      DEFAULT_PERSONALIZATION,
    )
    const value = { ...DEFAULT_PERSONALIZATION, accent: '#7c3aed' }
    expect((await call('/api/personalization', put(value))).status).toBe(200)
    expect((await read(await call('/api/personalization'))).personalization).toEqual(value)

    const reset = await call('/api/personalization', { method: 'DELETE' })
    expect((await read(reset)).personalization).toEqual(DEFAULT_PERSONALIZATION)
    expect(events).toEqual([
      { type: 'personalization.changed' },
      { type: 'personalization.changed' },
    ])
  })

  test('内容不合法返回 422，不广播', async () => {
    const r = await call('/api/personalization', put({ ...DEFAULT_PERSONALIZATION, base: 'dark' }))
    expect(r.status).toBe(422)
    expect(events).toEqual([])
  })

  test('设置背景图片：写入图片并切换背景，图片可经直链读取', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const r = await call('/api/personalization/image?name=bg.png', { method: 'PUT', body: bytes })
    expect(r.status).toBe(200)
    expect((await read(r)).personalization.background).toEqual({
      kind: 'image',
      file: 'bg.png',
      fit: 'cover',
      dim: 0.2,
      blur: 0,
    })

    const file = await call('/api/personalization/files/bg.png')
    expect(file.status).toBe(200)
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes)
    expect((await call('/api/personalization/files/missing.png')).status).toBe(404)
  })

  test('背景不可见时，设置图片在同一次保存中把不透明度改为 85%；背景已可见时保持原值', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const first = await call('/api/personalization/image?name=a.png', {
      method: 'PUT',
      body: bytes,
    })
    expect((await read(first)).personalization.opacity).toBe(0.85)
    expect((await read(await call('/api/personalization'))).personalization.opacity).toBe(0.85)
    expect(events).toEqual([{ type: 'personalization.changed' }])

    const current = (await read(await call('/api/personalization'))).personalization
    await call('/api/personalization', put({ ...current, opacity: 0.5 }))
    const second = await call('/api/personalization/image?name=b.png', {
      method: 'PUT',
      body: bytes,
    })
    expect((await read(second)).personalization.opacity).toBe(0.5)
  })

  test('图片文件名不合法时返回 422', async () => {
    const r = await call('/api/personalization/image?name=a.svg', { method: 'PUT', body: 'x' })
    expect(r.status).toBe(422)
  })
})

describe('界面偏好接口', () => {
  const prefs = async (r: Response) => (await r.json()) as UiPreferencesEntry
  const file = () => join(process.env.QYWORK_HOME!, 'preferences.json')

  test('从未保存时读取默认值；保存只提交改动的字段，其余字段保持；每次保存广播保存后的内容', async () => {
    expect(await prefs(await call('/api/preferences'))).toEqual({
      preferences: DEFAULT_UI_PREFERENCES,
      updatedAt: 0,
    })
    expect((await call('/api/preferences', put({ theme: 'dark' }))).status).toBe(200)
    const r = await prefs(await call('/api/preferences', put({ fontScale: 1.15 })))
    const expected: UiPreferences = { theme: 'dark', fontScale: 1.15, followUpMode: 'queue' }
    expect(r.preferences).toEqual(expected)
    expect(r.updatedAt).toBeGreaterThan(0)
    expect((await prefs(await call('/api/preferences'))).preferences).toEqual(expected)
    expect(events).toEqual([
      { type: 'preferences.changed', preferences: { ...expected, fontScale: 1 } },
      { type: 'preferences.changed', preferences: expected },
    ])
  })

  test('不合法的内容返回 422，不落盘、不广播', async () => {
    await call('/api/preferences', put({ theme: 'dark' }))
    const before = await readFile(file(), 'utf8')
    events = []
    for (const body of [{ theme: 'blue' }, { fontScale: 2 }, { followUpMode: 'later' }, { x: 1 }]) {
      expect((await call('/api/preferences', put(body))).status).toBe(422)
    }
    expect(await readFile(file(), 'utf8')).toBe(before)
    expect(events).toEqual([])
  })

  test('文件无法解析时读取返回 422 与原因；保存以默认值为基础覆盖该文件', async () => {
    await writeFile(file(), '{', 'utf8')
    const bad = await call('/api/preferences')
    expect(bad.status).toBe(422)
    expect(((await bad.json()) as { error: string }).error).toContain('preferences.json')
    const r = await prefs(await call('/api/preferences', put({ followUpMode: 'steer' })))
    expect(r.preferences).toEqual({ ...DEFAULT_UI_PREFERENCES, followUpMode: 'steer' })
    expect((await call('/api/preferences')).status).toBe(200)
  })
})

describe('宠物接口', () => {
  test('列出、读取、帧直链与删除，删除时广播', async () => {
    const all = { frames: ['a.png'], fps: 1 }
    const pack = {
      name: '猫',
      size: 64,
      states: { desktop: all, failed: all, working: all, done: all, idle: all },
    }
    const r = await savePet(null, pack, [{ name: 'a.png', bytes: new Uint8Array([1, 2]) }])
    if (!r.ok) throw new Error(r.error)
    const list = (await (await call('/api/pets')).json()) as { pets: { id: string }[] }
    expect(list.pets.map((p) => p.id)).toEqual([r.entry.id])
    expect((await call(`/api/pets/${r.entry.id}`)).status).toBe(200)
    const frame = await call(`/api/pets/${r.entry.id}/files/a.png`)
    expect(new Uint8Array(await frame.arrayBuffer())).toEqual(new Uint8Array([1, 2]))
    expect((await call(`/api/pets/${r.entry.id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await call(`/api/pets/${r.entry.id}`)).status).toBe(404)
    expect(events).toEqual([{ type: 'pets.changed', id: r.entry.id, removed: true }])
  })
})
