/** 覆盖 `skins.ts`：皮肤库的新建、替换、图片引用、校验先于落盘与删除。 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SKIN, type Skin } from '@qywork/core'
import { deleteSkin, listSkins, readSkin, saveSkin, skinImagePath, skinsDir } from './skins.ts'

let before: string | undefined

beforeEach(async () => {
  before = process.env.QYWORK_HOME
  process.env.QYWORK_HOME = await mkdtemp(join(tmpdir(), 'qy-skins-'))
})

afterEach(() => {
  if (before === undefined) delete process.env.QYWORK_HOME
  else process.env.QYWORK_HOME = before
})

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

const imageSkin = (file: string): Skin => ({
  ...DEFAULT_SKIN,
  name: '图片',
  background: { kind: 'image', file, fit: 'cover', dim: 0.2, blur: 0 },
})

describe('皮肤库', () => {
  test('新建后可列出与读取', async () => {
    const r = await saveSkin(null, { ...DEFAULT_SKIN, name: '夜' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.entry.id).toMatch(/^skin-/)
    expect((await readSkin(r.entry.id))?.skin.name).toBe('夜')
    const list = await listSkins()
    expect(list.skins.map((s) => s.id)).toEqual([r.entry.id])
    expect(list.failures).toEqual([])
  })

  test('内容不合法时返回 422 且不创建目录', async () => {
    const r = await saveSkin(null, { ...DEFAULT_SKIN, surface: { opacity: 5 } })
    expect(r).toMatchObject({ ok: false, status: 422 })
    expect(await readdir(skinsDir()).catch(() => [])).toEqual([])
  })

  test('引用的图片既未上传也不存在时拒绝', async () => {
    const r = await saveSkin(null, imageSkin('bg.png'))
    expect(r).toMatchObject({ ok: false, status: 422, error: '背景图片不存在：bg.png' })
  })

  test('换图后旧图片随同一次保存删除', async () => {
    const first = await saveSkin(null, imageSkin('a.png'), [{ name: 'a.png', bytes: png }])
    if (!first.ok) throw new Error(first.error)
    const id = first.entry.id
    expect(await skinImagePath(id, 'a.png')).not.toBeNull()

    const second = await saveSkin(id, imageSkin('b.png'), [{ name: 'b.png', bytes: png }])
    expect(second.ok).toBe(true)
    expect(await skinImagePath(id, 'a.png')).toBeNull()
    expect(await skinImagePath(id, 'b.png')).not.toBeNull()

    // 已存在的图片可直接引用，无需再次上传。
    const third = await saveSkin(id, { ...imageSkin('b.png'), name: '改名' })
    expect(third.ok).toBe(true)
  })

  test('替换不存在的皮肤返回 404，非法 id 返回 422', async () => {
    expect(await saveSkin('skin-none', DEFAULT_SKIN)).toMatchObject({ ok: false, status: 404 })
    expect(await saveSkin('../x', DEFAULT_SKIN)).toMatchObject({ ok: false, status: 422 })
  })

  test('图片文件名带路径时拒绝', async () => {
    const r = await saveSkin(null, DEFAULT_SKIN, [{ name: '../a.png', bytes: png }])
    expect(r).toMatchObject({ ok: false, status: 422 })
  })

  test('手动改坏的皮肤列入失败项', async () => {
    await mkdir(join(skinsDir(), 'broken'), { recursive: true })
    await writeFile(join(skinsDir(), 'broken', 'skin.json'), '{"name":1}')
    const list = await listSkins()
    expect(list.skins).toEqual([])
    expect(list.failures.map((f) => f.id)).toEqual(['broken'])
  })

  test('删除', async () => {
    const r = await saveSkin(null, DEFAULT_SKIN)
    if (!r.ok) throw new Error(r.error)
    expect(await deleteSkin(r.entry.id)).toBe(true)
    expect(await deleteSkin(r.entry.id)).toBe(false)
    expect(await readSkin(r.entry.id)).toBeNull()
  })
})
