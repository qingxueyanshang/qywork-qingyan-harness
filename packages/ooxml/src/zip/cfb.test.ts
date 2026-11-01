/**
 * 覆盖 `cfb.ts` 与 `index.ts` 中 `openZip` 的 CFB 分类：加密包、三种旧二进制格式、只计根存储的直接子项、
 * 名称不区分大小写、左右兄弟的遍历、目录占多个扇区、4096 字节扇区、经 DIFAT 扇区定位的 FAT、
 * 文件头无效、结构截断与目录树成环。
 *
 * 夹具由测试内的 CFB 写入函数按扇区布局生成。
 */

import { describe, expect, test } from 'bun:test'
import { cfbRootStreams } from './cfb.ts'
import { openZip } from './index.ts'

const FREE = 0xffffffff
const END = 0xfffffffe
const FAT_MARK = 0xfffffffd
const DIFAT_MARK = 0xfffffffc

interface Node {
  name: string
  type: 1 | 2 | 5
  left?: number
  right?: number
  child?: number
}

/**
 * 按 `nodes` 生成目录（下标即目录项编号），目录扇区从 `directoryAt` 起连续存放。
 * FAT 扇区依次放在扇区 0、1、…；所需 FAT 扇区的序号不小于 109 时，DIFAT 扇区紧随其后。
 */
function cfbFile(
  nodes: Node[],
  options: { shift?: 9 | 12; directoryAt?: number } = {},
): Uint8Array<ArrayBuffer> {
  const shift = options.shift ?? 9
  const size = 1 << shift
  const per = size / 4
  const perDirectory = size / 128
  const directoryAt = options.directoryAt ?? 1
  const directory = Array.from(
    { length: Math.ceil(nodes.length / perDirectory) },
    (_, i) => directoryAt + i,
  )
  const fatIndices = [...new Set(directory.map((s) => Math.floor(s / per)))]
  const fatAt = new Map(fatIndices.map((index, i) => [index, i]))
  const needsDifat = fatIndices.some((index) => index >= 109)
  const difatAt = needsDifat ? fatIndices.length : -1
  const last = Math.max(directory.at(-1)!, needsDifat ? difatAt : fatIndices.length - 1)
  const bytes = new Uint8Array((last + 2) * size)
  const view = new DataView(bytes.buffer)
  const offsetOf = (s: number) => (s + 1) * size

  bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
  view.setUint16(24, 0x3e, true)
  view.setUint16(26, shift === 9 ? 3 : 4, true)
  view.setUint16(28, 0xfffe, true)
  view.setUint16(30, shift, true)
  view.setUint16(32, 6, true)
  view.setUint32(44, fatIndices.length, true)
  view.setUint32(48, directoryAt, true)
  view.setUint32(56, 4096, true)
  view.setUint32(60, END, true)
  view.setUint32(68, needsDifat ? difatAt : END, true)
  view.setUint32(72, needsDifat ? 1 : 0, true)
  for (let i = 0; i < 109; i++) view.setUint32(76 + i * 4, fatAt.get(i) ?? FREE, true)
  if (needsDifat) {
    for (let k = 0; k < per; k++) {
      const value = k === per - 1 ? END : (fatAt.get(109 + k) ?? FREE)
      view.setUint32(offsetOf(difatAt) + k * 4, value, true)
    }
  }
  const fatLocations = new Set(fatAt.values())
  for (const [index, at] of fatAt) {
    for (let k = 0; k < per; k++) {
      const s = index * per + k
      const d = directory.indexOf(s)
      let value = FREE
      if (d >= 0) value = d === directory.length - 1 ? END : directory[d + 1]!
      else if (fatLocations.has(s)) value = FAT_MARK
      else if (s === difatAt) value = DIFAT_MARK
      view.setUint32(offsetOf(at) + k * 4, value, true)
    }
  }
  for (let id = 0; id < directory.length * perDirectory; id++) {
    const base = offsetOf(directory[Math.floor(id / perDirectory)]!) + (id % perDirectory) * 128
    const node = nodes[id]
    view.setUint32(base + 68, node?.left ?? FREE, true)
    view.setUint32(base + 72, node?.right ?? FREE, true)
    view.setUint32(base + 76, node?.child ?? FREE, true)
    if (node === undefined) continue
    for (let i = 0; i < node.name.length; i++) {
      view.setUint16(base + i * 2, node.name.charCodeAt(i), true)
    }
    view.setUint16(base + 64, (node.name.length + 1) * 2, true)
    view.setUint8(base + 66, node.type)
    view.setUint8(base + 67, 1)
    view.setUint32(base + 116, END, true)
  }
  return bytes
}

function stream(name: string): Node {
  return { name, type: 2 }
}

/** 根存储的子项从目录项 1 起依次以右兄弟相连。 */
function rootWith(...children: Node[]): Node[] {
  return [
    { name: 'Root Entry', type: 5, child: 1 },
    ...children.map((c, i) => (i + 1 < children.length ? { ...c, right: i + 2 } : c)),
  ]
}

function failureOf(bytes: Uint8Array<ArrayBuffer>) {
  const opened = openZip(bytes)
  return opened.ok ? null : opened.failure
}

function viewOf(bytes: Uint8Array<ArrayBuffer>): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

describe('按根存储下的流分类', () => {
  test('EncryptedPackage 判为已加密', () => {
    const file = cfbFile(
      rootWith(
        { name: '\u0006DataSpaces', type: 1 },
        stream('EncryptionInfo'),
        stream('EncryptedPackage'),
      ),
    )
    expect(failureOf(file)).toEqual({ kind: 'encrypted' })
  })

  test('Workbook 判为旧二进制格式', () => {
    const file = cfbFile(rootWith(stream('Workbook'), stream('\u0005SummaryInformation')))
    expect(failureOf(file)).toEqual({ kind: 'legacy' })
  })

  test('WordDocument 判为旧二进制格式，左右兄弟都遍历', () => {
    const file = cfbFile([
      { name: 'Root Entry', type: 5, child: 2 },
      stream('WordDocument'),
      { name: 'Data', type: 2, left: 1, right: 3 },
      stream('1Table'),
    ])
    expect(cfbRootStreams(viewOf(file))).toEqual(new Set(['WORDDOCUMENT', 'DATA', '1TABLE']))
    expect(failureOf(file)).toEqual({ kind: 'legacy' })
  })

  test('PowerPoint Document 判为旧二进制格式，目录占两个扇区', () => {
    const file = cfbFile(
      rootWith(
        stream('Current User'),
        stream('\u0005SummaryInformation'),
        stream('\u0005DocumentSummaryInformation'),
        stream('Pictures'),
        stream('PowerPoint Document'),
      ),
    )
    expect(file.length).toBe(512 * 4)
    expect(failureOf(file)).toEqual({ kind: 'legacy' })
  })

  test('名称不区分大小写', () => {
    expect(failureOf(cfbFile(rootWith(stream('WORKBOOK'))))).toEqual({ kind: 'legacy' })
  })

  test('嵌套存储中的流不计入，两者都没有时判为已损坏', () => {
    const file = cfbFile([
      { name: 'Root Entry', type: 5, child: 1 },
      { name: 'ObjectPool', type: 1, child: 2, right: 3 },
      stream('Workbook'),
      stream('\u0005SummaryInformation'),
    ])
    expect(cfbRootStreams(viewOf(file))).toEqual(new Set(['\u0005SUMMARYINFORMATION']))
    expect(failureOf(file)).toEqual({ kind: 'corrupt', reason: 'cfb-unrecognized' })
  })

  test('4096 字节扇区', () => {
    const file = cfbFile(rootWith(stream('EncryptionInfo'), stream('EncryptedPackage')), {
      shift: 12,
    })
    expect(failureOf(file)).toEqual({ kind: 'encrypted' })
  })

  test('目录扇区所在的 FAT 扇区经 DIFAT 扇区定位', () => {
    const file = cfbFile(rootWith(stream('Workbook')), { directoryAt: 109 * 128 })
    expect(failureOf(file)).toEqual({ kind: 'legacy' })
  })
})

describe('结构不完整判为已损坏', () => {
  const legacy = () => cfbFile(rootWith(stream('\u0005SummaryInformation'), stream('Workbook')))

  test('截断到目录扇区之前、截断在文件头内', () => {
    const file = legacy()
    for (const length of [1024, 300, 8]) {
      expect(failureOf(file.slice(0, length))).toEqual({
        kind: 'corrupt',
        reason: 'cfb-structure',
      })
    }
  })

  test('目录项被截断', () => {
    const file = legacy()
    expect(failureOf(file.slice(0, file.length - 512 + 200))).toEqual({
      kind: 'corrupt',
      reason: 'cfb-structure',
    })
  })

  test('文件头的字节序标记或扇区大小无效', () => {
    const byteOrder = legacy()
    viewOf(byteOrder).setUint16(28, 0xfeff, true)
    expect(failureOf(byteOrder)).toEqual({ kind: 'corrupt', reason: 'cfb-structure' })
    const sectorShift = legacy()
    viewOf(sectorShift).setUint16(30, 10, true)
    expect(failureOf(sectorShift)).toEqual({ kind: 'corrupt', reason: 'cfb-structure' })
  })

  test('目录链或目录树成环', () => {
    const chain = cfbFile(rootWith(stream('A'), stream('B'), stream('C'), stream('D')))
    viewOf(chain).setUint32(512 + 2 * 4, 1, true)
    expect(failureOf(chain)).toEqual({ kind: 'corrupt', reason: 'cfb-structure' })
    const tree = cfbFile([
      { name: 'Root Entry', type: 5, child: 1 },
      { name: 'A', type: 2, right: 2 },
      { name: 'B', type: 2, right: 1 },
    ])
    expect(failureOf(tree)).toEqual({ kind: 'corrupt', reason: 'cfb-structure' })
  })
})
