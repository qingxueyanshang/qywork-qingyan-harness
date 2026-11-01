/** 覆盖 `pets.ts`：宠物库的新建、替换、帧引用、校验先于落盘与删除。 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PetPack } from '@qywork/core'
import { deletePet, listPets, petImagePath, petsDir, readPet, savePet } from './pets.ts'

let before: string | undefined

beforeEach(async () => {
  before = process.env.QYWORK_HOME
  process.env.QYWORK_HOME = await mkdtemp(join(tmpdir(), 'qy-pets-'))
})

afterEach(() => {
  if (before === undefined) delete process.env.QYWORK_HOME
  else process.env.QYWORK_HOME = before
})

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
const all = (file: string) => ({ frames: [file], fps: 1 })
const packOf = (file: string): PetPack => ({
  name: '猫',
  size: 64,
  states: {
    desktop: all(file),
    failed: all(file),
    working: all(file),
    done: all(file),
    idle: all(file),
  },
})

describe('宠物库', () => {
  test('新建后可列出与读取；替换时未引用的帧随同一次保存删除', async () => {
    const r = await savePet(null, packOf('a.png'), [{ name: 'a.png', bytes: png }])
    if (!r.ok) throw new Error(r.error)
    expect((await listPets()).pets.map((p) => p.id)).toEqual([r.entry.id])
    const next = await savePet(r.entry.id, packOf('b.png'), [{ name: 'b.png', bytes: png }])
    expect(next.ok).toBe(true)
    expect(await petImagePath(r.entry.id, 'a.png')).toBeNull()
    expect(await petImagePath(r.entry.id, 'b.png')).not.toBeNull()
    // 已在库中的帧无需再次写入。
    expect((await savePet(r.entry.id, { ...packOf('b.png'), name: '改名' })).ok).toBe(true)
    expect((await readPet(r.entry.id))?.pack.name).toBe('改名')
  })

  test('引用的帧不存在、内容不合法时拒绝且不创建目录', async () => {
    expect(await savePet(null, packOf('a.png'))).toMatchObject({
      ok: false,
      status: 422,
      error: '帧图片不存在：a.png',
    })
    expect(await savePet(null, { name: 'x' })).toMatchObject({ ok: false, status: 422 })
    expect(await readdir(petsDir()).catch(() => [])).toEqual([])
  })

  test('替换不存在的宠物返回 404；删除', async () => {
    expect(
      await savePet('pet-none', packOf('a.png'), [{ name: 'a.png', bytes: png }]),
    ).toMatchObject({ ok: false, status: 404 })
    const r = await savePet(null, packOf('a.png'), [{ name: 'a.png', bytes: png }])
    if (!r.ok) throw new Error(r.error)
    expect(await deletePet(r.entry.id)).toBe(true)
    expect(await deletePet(r.entry.id)).toBe(false)
  })
})
