/**
 * 覆盖 `subset.ts`：按码位裁剪后保留字形的轮廓、前进宽度与点阵不变，未保留的字形没有轮廓与点阵，strike 全部保留；
 * `cmap` 只含给定码位且字形编号不变，`kern` 只含保留字形之间的字偶且值不变；`GSUB` 替换得到的字形一并保留；
 * 含 `MATH` 表的字体原样返回。
 *
 * 读取本机 Windows 字体目录中的宋体（索引格式 1 的点阵）、MS Gothic（固定度量的点阵）、Calibri（`kern` 表）
 * 与 Cambria Math（`MATH` 表）。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fontsAvailable } from '../test-fonts.ts'
import { readCmap } from './cmap.ts'
import { readKerning } from './features/kern.ts'
import {
  extractFace,
  readEmbeddedBitmaps,
  readFaces,
  readGlyphOutlines,
  readSingleSubstitution,
  subsetFace,
  tableBytes,
} from './index.ts'

const FONTS = join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts')
const face = (file: string, index = 0) =>
  extractFace(new Uint8Array(readFileSync(join(FONTS, file))), index)
const points = (text: string) => [...text].map((c) => c.codePointAt(0)!)

describe.skipIf(!fontsAvailable(['simsun.ttc', 'msgothic.ttc', 'cambria.ttc', 'calibri.ttf']))(
  '本机字体',
  () => {
    for (const file of ['simsun.ttc', 'msgothic.ttc']) {
      test(`${file}：保留字形的轮廓、前进宽度与各字号点阵不变，其余字形为空；strike 全部保留`, () => {
        const full = face(file)
        const kept = '永和九年，岁在癸丑。Hello 2026（甲）'
        const sub = subsetFace(full, points(kept))
        expect(sub.length).toBeLessThan(full.length / 8)

        const [a] = readFaces(full)
        const [b] = readFaces(sub)
        const glyphOf = readCmap(tableBytes(full, a!, 'cmap'))
        const oa = readGlyphOutlines(full, a!)!
        const ob = readGlyphOutlines(sub, b!)!
        const ba = readEmbeddedBitmaps(full, a!)!
        const bb = readEmbeddedBitmaps(sub, b!)!
        expect(bb.sizes).toEqual(ba.sizes)
        for (const g of points(kept).map(glyphOf)) {
          expect(ob.outline(g)).toEqual(oa.outline(g))
          expect(ob.advance(g)).toBe(oa.advance(g))
          for (const ppem of ba.sizes) {
            expect(bb.glyph(ppem, g, false)).toEqual(ba.glyph(ppem, g, false))
            expect(bb.screenMode(ppem)).toBe(ba.screenMode(ppem))
          }
        }
        // 绝大多数字形不再有轮廓，前进宽度仍与原字体相同。
        let inked = 0
        for (let g = 0; g < oa.numGlyphs; g++) {
          expect(ob.advance(g)).toBe(oa.advance(g))
          if (ob.outline(g).length > 0) inked++
        }
        expect(inked).toBeLessThan(oa.numGlyphs / 20)
      })
    }

    test('GSUB 替换得到的字形一并保留：竖排的括号', () => {
      const full = face('msgothic.ttc')
      const sub = subsetFace(full, points('（'))
      const [b] = readFaces(sub)
      const g = readCmap(tableBytes(sub, b!, 'cmap'))('（'.codePointAt(0)!)
      const vert = readSingleSubstitution(sub, b!, 'vert')!(g)
      expect(vert).not.toBe(g)
      expect(readGlyphOutlines(sub, b!)!.outline(vert).length).toBeGreaterThan(0)
    })

    test('cmap 只含给定码位且字形编号不变；kern 只含保留字形之间的字偶且值不变', () => {
      const full = face('calibri.ttf')
      const sub = subsetFace(full, points('AVTo.'))
      const [a] = readFaces(full)
      const [b] = readFaces(sub)
      const before = readCmap(tableBytes(full, a!, 'cmap'))
      const after = readCmap(tableBytes(sub, b!, 'cmap'))
      for (const c of points('AVTo.')) expect(after(c)).toBe(before(c))
      expect(before('Z'.codePointAt(0)!)).toBeGreaterThan(0)
      expect(after('Z'.codePointAt(0)!)).toBe(0)
      const ka = readKerning(full, a!)!
      const kb = readKerning(sub, b!)!
      const [A, V, T, o] = points('AVTo').map(before)
      expect(ka(A!, V!)).not.toBe(0)
      expect(kb(A!, V!)).toBe(ka(A!, V!))
      expect(kb(T!, o!)).toBe(ka(T!, o!))
      expect(tableBytes(sub, b!, 'kern').length).toBeLessThan(
        tableBytes(full, a!, 'kern').length / 10,
      )
    })

    test('含 MATH 表的字体原样返回', () => {
      const math = face('cambria.ttc', 1)
      expect(readFaces(math)[0]!.tables.has('MATH')).toBe(true)
      expect(subsetFace(math, points('x'))).toBe(math)
    })
  },
)
