/**
 * 主机字体接口（`api/fonts.ts`）：字体目录表、按字体名解析、按标识取字节、TTC 拆分结果、
 * 参数校验、未找到、缓存头、字体安装后下一次请求可见，以及在派发器中的注册。
 *
 * 系统字体取自本机 Windows 字体目录；用户字体目录指向临时目录，用例之间不受本机已安装的用户字体影响。
 * 环境变量在任何请求之前设置：索引按首次请求时的目录清单建立。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFaces, readFamilyNames, tableBytes } from '@qywork/ooxml/font'
import { Store, upsertWorkspace } from '@qywork/store'
import { fontRoots, handleFontsApi } from './fonts.ts'
import { type ApiDeps, handleApi } from './index.ts'

describe('字体目录', () => {
  test('Windows 为系统目录与当前用户目录，环境变量缺失时略去对应目录', () => {
    const env = { WINDIR: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }
    expect(fontRoots('win32', env, 'C:\\Users\\u')).toEqual([
      'C:\\Windows\\Fonts',
      'C:\\Users\\u\\AppData\\Local\\Microsoft\\Windows\\Fonts',
    ])
    expect(fontRoots('win32', {}, 'C:\\Users\\u')).toEqual([])
  })

  test('macOS 与 Linux 为系统目录与用户主目录下的字体目录', () => {
    expect(fontRoots('darwin', {}, '/Users/u')).toEqual([
      '/System/Library/Fonts',
      '/Library/Fonts',
      '/Users/u/Library/Fonts',
    ])
    expect(fontRoots('linux', {}, '/home/u')).toEqual([
      '/usr/share/fonts',
      '/usr/local/share/fonts',
      '/home/u/.local/share/fonts',
      '/home/u/.fonts',
    ])
  })
})

const get = (path: string, method = 'GET') => {
  const url = new URL(`http://127.0.0.1${path}`)
  return handleFontsApi(url, new Request(url.href, { method }), {} as never)
}
const faces = async (name: string) => {
  const res = await get(`/api/fonts?name=${encodeURIComponent(name)}`)
  return { status: res?.status, body: (await res?.json()) as { faces: Face[] } }
}
const file = (name: string, id: string) =>
  get(`/api/fonts/file?name=${encodeURIComponent(name)}&id=${id}`)
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

interface Face {
  id: string
  bold: boolean
  italic: boolean
}

describe.skipIf(process.platform !== 'win32')('本机字体', () => {
  let local = ''
  let userFonts = ''
  const previous = process.env.LOCALAPPDATA
  beforeAll(async () => {
    local = await mkdtemp(join(tmpdir(), 'qywork-fonts-'))
    process.env.LOCALAPPDATA = local
    userFonts = join(local, 'Microsoft', 'Windows', 'Fonts')
  })
  afterAll(async () => {
    if (previous === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = previous
    await rm(local, { recursive: true, force: true })
  })

  test('按中文名与英文名解析到同一个宋体，名称不区分大小写', async () => {
    const zh = await faces('宋体')
    expect(zh.status).toBe(200)
    expect(zh.body.faces).toHaveLength(1)
    expect(zh.body.faces[0]).toMatchObject({ bold: false, italic: false })
    expect(zh.body.faces[0]!.id).toMatch(/^[0-9a-f]{64}$/)
    expect((await faces('simsun')).body).toEqual(zh.body)
  })

  test('同一家族的粗体与斜体各返回一项', async () => {
    const { body } = await faces('Arial')
    expect(body.faces.map((f) => [f.bold, f.italic]).sort()).toEqual([
      [false, false],
      [false, true],
      [true, false],
      [true, true],
    ])
    expect(new Set(body.faces.map((f) => f.id)).size).toBe(4)
  })

  test('TTC 中的字体拆为独立 sfnt：字节可解析，家族名正确，哈希与标识一致，带长缓存头', async () => {
    for (const [name, family] of [
      ['宋体', 'SimSun'],
      ['新宋体', 'NSimSun'],
    ] as const) {
      const { body } = await faces(name)
      const id = body.faces[0]!.id
      const res = await file(name, id)
      expect(res?.status).toBe(200)
      expect(res?.headers.get('content-type')).toBe('font/ttf')
      expect(res?.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
      const bytes = new Uint8Array(await res!.arrayBuffer())
      expect(sha256(bytes)).toBe(id)
      expect(new DataView(bytes.buffer).getUint32(0)).toBe(0x00010000)
      const own = readFaces(bytes)
      expect(own).toHaveLength(1)
      expect(readFamilyNames(tableBytes(bytes, own[0]!, 'name'))).toContain(family)
    }
    expect((await faces('宋体')).body.faces[0]!.id).not.toBe(
      (await faces('新宋体')).body.faces[0]!.id,
    )
  })

  test('单个字体文件按原字节下发', async () => {
    const { body } = await faces('黑体')
    const res = await file('黑体', body.faces[0]!.id)
    const original = readFileSync(join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts', 'simhei.ttf'))
    expect(new Uint8Array(await res!.arrayBuffer())).toEqual(new Uint8Array(original))
  })

  test('主机上没有的字体名与不匹配的标识返回 404', async () => {
    expect((await faces('qywork 不存在的字体')).status).toBe(404)
    expect((await file('qywork 不存在的字体', '0'.repeat(64)))?.status).toBe(404)
    expect((await file('宋体', '0'.repeat(64)))?.status).toBe(404)
  })

  test('字体安装到用户字体目录后，下一次请求即可见', async () => {
    expect((await faces('Qywkt')).status).toBe(404)
    await mkdir(userFonts, { recursive: true })
    const arial = new Uint8Array(readFileSync(join(process.env.WINDIR ?? '', 'Fonts', 'arial.ttf')))
    await writeFile(join(userFonts, 'qywkt.ttf'), renameFamily(arial, 'Arial', 'Qywkt'))
    const { status, body } = await faces('Qywkt')
    expect(status).toBe(200)
    const res = await file('Qywkt', body.faces[0]!.id)
    const bytes = new Uint8Array(await res!.arrayBuffer())
    expect(readFamilyNames(tableBytes(bytes, readFaces(bytes)[0]!, 'name'))).toEqual(['Qywkt'])
  })
})

/** 把 `name` 表中等长的家族名逐字节替换（Mac Roman 与 UTF-16BE 两种写法），得到一个本机未安装的家族。 */
function renameFamily(bytes: Uint8Array, from: string, to: string): Uint8Array {
  const out = bytes.slice()
  const table = tableBytes(out, readFaces(out)[0]!, 'name')
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))
  const utf16 = (s: string) => ascii(s).flatMap((c) => [0, c])
  for (const [a, b] of [
    [ascii(from), ascii(to)],
    [utf16(from), utf16(to)],
  ] as const) {
    for (let i = 0; i + a.length <= table.length; i++) {
      if (a.every((x, k) => table[i + k] === x)) table.set(b, i)
    }
  }
  return out
}

describe('参数校验', () => {
  test('字体名含路径形状或控制字符时两个接口均返回 422', async () => {
    const id = '0'.repeat(64)
    for (const name of [
      '../simsun.ttc',
      'Fonts/simsun.ttc',
      'C:\\Windows\\Fonts\\simsun.ttc',
      '..',
      '',
      '  ',
      'a\u0000b',
    ]) {
      expect((await get(`/api/fonts?name=${encodeURIComponent(name)}`))?.status).toBe(422)
      expect((await file(name, id))?.status).toBe(422)
    }
    expect((await get('/api/fonts'))?.status).toBe(422)
  })

  test('标识不是 64 位小写十六进制时返回 422', async () => {
    for (const id of ['abc', 'A'.repeat(64), `../${'0'.repeat(61)}`, `${'0'.repeat(63)}/`]) {
      expect((await file('宋体', encodeURIComponent(id)))?.status).toBe(422)
    }
    expect((await get('/api/fonts/file?name=Arial'))?.status).toBe(422)
  })

  test('其他方法与其他路径不由本模块处理', async () => {
    expect(await get('/api/fonts?name=Arial', 'POST')).toBe(null)
    expect(await get('/api/fonts/other?name=Arial')).toBe(null)
  })

  test('派发器已注册本模块', async () => {
    const store = new Store({ path: ':memory:' })
    upsertWorkspace(store, '/ws/demo', 'demo')
    const url = new URL('http://127.0.0.1/api/fonts?name=..')
    const res = await handleApi(url, new Request(url.href), { store } as unknown as ApiDeps)
    expect(res?.status).toBe(422)
  })
})
