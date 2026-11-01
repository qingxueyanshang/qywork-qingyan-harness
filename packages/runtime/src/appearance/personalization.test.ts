/** 覆盖 `personalization.ts`：读取默认值、保存、图片引用、校验先于落盘与恢复默认。 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_PERSONALIZATION, type Personalization } from '@qywork/core'
import {
  personalImagePath,
  personalizationDir,
  readPersonalization,
  resetPersonalization,
  savePersonalization,
} from './personalization.ts'

let before: string | undefined

beforeEach(async () => {
  before = process.env.QYWORK_HOME
  process.env.QYWORK_HOME = await mkdtemp(join(tmpdir(), 'qy-personal-'))
})

afterEach(() => {
  if (before === undefined) delete process.env.QYWORK_HOME
  else process.env.QYWORK_HOME = before
})

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

const withImage = (file: string): Personalization => ({
  ...DEFAULT_PERSONALIZATION,
  background: { kind: 'image', file, fit: 'cover', dim: 0.2, blur: 0 },
  opacity: 0.85,
})

describe('个性化', () => {
  test('从未保存时读取到默认值', async () => {
    expect(await readPersonalization()).toEqual({
      ok: true,
      entry: { personalization: DEFAULT_PERSONALIZATION, updatedAt: 0 },
    })
  })

  test('保存后可读取', async () => {
    const value = { ...DEFAULT_PERSONALIZATION, accent: '#7c3aed' }
    expect((await savePersonalization(value)).ok).toBe(true)
    const r = await readPersonalization()
    expect(r.ok && r.entry.personalization).toEqual(value)
    expect(r.ok && r.entry.updatedAt).toBeGreaterThan(0)
  })

  test('内容不合法时返回错误且不创建目录', async () => {
    const r = await savePersonalization({ ...DEFAULT_PERSONALIZATION, opacity: 5 })
    expect(r.ok).toBe(false)
    expect(await readdir(personalizationDir()).catch(() => [])).toEqual([])
  })

  test('引用的图片既未上传也不存在时拒绝', async () => {
    expect(await savePersonalization(withImage('bg.png'))).toEqual({
      ok: false,
      error: '背景图片不存在：bg.png',
    })
  })

  test('换图后旧图片随同一次保存删除', async () => {
    expect(
      (await savePersonalization(withImage('a.png'), [{ name: 'a.png', bytes: png }])).ok,
    ).toBe(true)
    expect(await personalImagePath('a.png')).not.toBeNull()
    expect(
      (await savePersonalization(withImage('b.png'), [{ name: 'b.png', bytes: png }])).ok,
    ).toBe(true)
    expect(await personalImagePath('a.png')).toBeNull()
    expect(await personalImagePath('b.png')).not.toBeNull()
  })

  test('文件被手动改坏时返回错误而不是默认值', async () => {
    await mkdir(personalizationDir(), { recursive: true })
    await writeFile(join(personalizationDir(), 'personalization.json'), '{"opacity": 9}')
    const r = await readPersonalization()
    expect(r.ok).toBe(false)
  })

  test('恢复默认删除整个目录，包括图片', async () => {
    await savePersonalization(withImage('a.png'), [{ name: 'a.png', bytes: png }])
    expect(await resetPersonalization()).toEqual({
      personalization: DEFAULT_PERSONALIZATION,
      updatedAt: 0,
    })
    expect(await readdir(personalizationDir()).catch(() => null)).toBeNull()
    expect(await personalImagePath('a.png')).toBeNull()
  })
})
