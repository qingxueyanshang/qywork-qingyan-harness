/**
 * 覆盖 `api/appearance.ts`：皮肤库接口的读写、背景图片设置、图片直链与 `skins.changed` 广播；
 * 宠物库接口的读取、删除、帧直链与 `pets.changed` 广播。
 *
 * 只构造 `bus` 一个依赖：接口不读取项目与配置，其余字段构造后即成为集成测试。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type AgentEvent, DEFAULT_SKIN, type SkinEntry } from '@qywork/core'
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

describe('皮肤接口', () => {
  test('新建、读取、替换、删除，每次修改都广播', async () => {
    const created = await call('/api/skins', { method: 'POST', body: JSON.stringify(DEFAULT_SKIN) })
    expect(created.status).toBe(201)
    const entry = (await created.json()) as SkinEntry

    expect(((await (await call(`/api/skins/${entry.id}`)).json()) as SkinEntry).skin.name).toBe(
      '新皮肤',
    )

    const replaced = await call(`/api/skins/${entry.id}`, put({ ...DEFAULT_SKIN, name: '夜' }))
    expect(replaced.status).toBe(200)

    const list = (await (await call('/api/skins')).json()) as { skins: SkinEntry[] }
    expect(list.skins.map((s) => s.skin.name)).toEqual(['夜'])

    expect((await call(`/api/skins/${entry.id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await call(`/api/skins/${entry.id}`)).status).toBe(404)
    expect(events).toEqual([
      { type: 'skins.changed', id: entry.id, removed: false },
      { type: 'skins.changed', id: entry.id, removed: false },
      { type: 'skins.changed', id: entry.id, removed: true },
    ])
  })

  test('内容不合法返回 422，不广播', async () => {
    const r = await call('/api/skins', { method: 'POST', body: JSON.stringify({ name: '' }) })
    expect(r.status).toBe(422)
    expect(events).toEqual([])
  })

  test('设置背景图片：写入图片并切换背景，图片可经直链读取', async () => {
    const entry = (await (
      await call('/api/skins', { method: 'POST', body: JSON.stringify(DEFAULT_SKIN) })
    ).json()) as SkinEntry
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const r = await call(`/api/skins/${entry.id}/image?name=bg.png`, { method: 'PUT', body: bytes })
    expect(r.status).toBe(200)
    const next = (await r.json()) as SkinEntry
    expect(next.skin.background).toEqual({
      kind: 'image',
      file: 'bg.png',
      fit: 'cover',
      dim: 0.2,
      blur: 0,
    })

    const file = await call(`/api/skins/${entry.id}/files/bg.png`)
    expect(file.status).toBe(200)
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes)
    expect((await call(`/api/skins/${entry.id}/files/missing.png`)).status).toBe(404)
  })

  test('图片文件名不合法或皮肤不存在', async () => {
    expect(
      (await call('/api/skins/skin-x/image?name=a.svg', { method: 'PUT', body: 'x' })).status,
    ).toBe(422)
    expect(
      (await call('/api/skins/skin-x/image?name=a.png', { method: 'PUT', body: 'x' })).status,
    ).toBe(404)
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
