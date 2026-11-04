/**
 * 字体特性表。覆盖 `kern.ts`（格式 0 子表、字偶数超出 16 位长度字段的子表）、`gsub.ts`（经扩展查找包装的单字替换）、
 * `coverage.ts`（格式 1 与 2），以及 `../metrics.ts` 中按码位的字偶查询与 `../vertical.ts` 的代码页。
 *
 * 读取本机 Windows 字体目录中的真实文件：其他平台跳过（`skipIf`）。期望值取自独立实现（fontTools 4.62）对同一文件的读取，
 * 代码页取自 Word 写入文档字体表的 `w:sig/@w:csb0`，不由本模块计算。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readFaces, readMetrics, readSingleSubstitution, readVerticalMetrics } from '../index.ts'
import { readKerning } from './kern.ts'

const FONTS = join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts')
const open = (file: string, index = 0) => {
  const bytes = new Uint8Array(readFileSync(join(FONTS, file)))
  return { bytes, face: readFaces(bytes)[index]! }
}

describe.skipIf(process.platform !== 'win32')('字体特性表（本机字体）', () => {
  test('kern 表：Times New Roman 的 AV 为 -264；Calibri 的 26706 个字偶超出子表长度字段后照常读取', () => {
    const times = open('times.ttf')
    const m = readMetrics(times.bytes, times.face)
    expect(m.kerning(0x41, 0x56)).toBe(-264)
    expect(m.kerning(0x41, 0x42)).toBe(0)
    const calibri = open('calibri.ttf')
    const c = readMetrics(calibri.bytes, calibri.face)
    const pair = (a: string, b: string) => c.kerning(a.codePointAt(0)!, b.codePointAt(0)!)
    expect([pair('A', 'V'), pair('T', 'q'), pair('y', 'o')]).toEqual([-89, -147, -24])
    // 表中最后一个字偶（字形 1231 与 1231）位于 16 位长度字段所示范围之外。
    expect(readKerning(calibri.bytes, calibri.face)?.(1231, 1231)).toBe(10)
  })

  test('没有 kern 表的字体（Georgia、宋体）字偶为 0', () => {
    for (const file of ['georgia.ttf', 'simsun.ttc']) {
      const f = open(file)
      expect(readKerning(f.bytes, f.face)).toBeNull()
      expect(readMetrics(f.bytes, f.face).kerning(0x41, 0x56)).toBe(0)
    }
  })

  test('GSUB 单字替换：Cambria Math 的 flac 经扩展查找包装，扬抑符各变体映射为扁平形式', () => {
    const math = open('cambria.ttc', 1)
    const flac = readSingleSubstitution(math.bytes, math.face, 'flac')!
    expect([440, 3548, 3549, 3550, 3551, 1876].map(flac)).toEqual([
      4632, 3552, 3553, 3554, 3555, 1876,
    ])
    expect(readSingleSubstitution(math.bytes, math.face, 'zzzz')).toBeNull()
    const song = open('simsun.ttc')
    expect(readSingleSubstitution(song.bytes, song.face, 'flac')).toBeNull()
  })

  test('OS/2 代码页：宋体 GB2312，Yu Gothic 日文，Times New Roman 没有中日韩代码页', () => {
    const pages = (file: string) => {
      const f = open(file)
      return readVerticalMetrics(f.bytes, f.face).codePages
    }
    expect(pages('simsun.ttc')).toBe(0x00040001)
    expect(pages('YuGothR.ttc')).toBe(0x2002009f)
    expect(pages('times.ttf')).toBe(0x400001ff)
  })
})
