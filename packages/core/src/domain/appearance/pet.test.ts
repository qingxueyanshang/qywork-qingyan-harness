/** 覆盖 `pet.ts`：宠物包校验、文件名判定与引用的文件。 */

import { describe, expect, test } from 'bun:test'
import { isPetImageName, type PetPack, parsePetPack, petFrameFiles } from './pet.ts'

const one = (file: string) => ({ frames: [file], fps: 1 })
const pack: PetPack = {
  name: '团子',
  size: 64,
  states: {
    desktop: one('desktop.png'),
    failed: one('failed.png'),
    working: { frames: ['w1.png', 'w2.png', 'w1.png'], fps: 4 },
    done: one('done.png'),
    idle: one('idle.png'),
  },
}

describe('parsePetPack', () => {
  test('合法宠物包原样通过', () => {
    expect(parsePetPack(pack)).toEqual({ ok: true, value: pack })
  })

  test('缺少任一状态时拒绝', () => {
    const { idle: _, ...rest } = pack.states
    expect(parsePetPack({ ...pack, states: rest })).toEqual({ ok: false, error: '缺少状态 idle' })
  })

  test('未知字段、未知状态、越界数值、带路径的文件名被拒绝', () => {
    expect(parsePetPack({ ...pack, extra: 1 }).ok).toBe(false)
    expect(parsePetPack({ ...pack, states: { ...pack.states, sleep: one('a.png') } }).ok).toBe(
      false,
    )
    expect(parsePetPack({ ...pack, size: 8 }).ok).toBe(false)
    expect(
      parsePetPack({ ...pack, states: { ...pack.states, idle: { frames: ['a.png'], fps: 0 } } }).ok,
    ).toBe(false)
    expect(parsePetPack({ ...pack, states: { ...pack.states, idle: one('../a.png') } }).ok).toBe(
      false,
    )
  })
})

test('文件名判定与引用的文件去重', () => {
  expect(isPetImageName('a.svg')).toBe(true)
  expect(isPetImageName('a.exe')).toBe(false)
  expect(petFrameFiles(pack).sort()).toEqual(
    ['desktop.png', 'done.png', 'failed.png', 'idle.png', 'w1.png', 'w2.png'].sort(),
  )
})
