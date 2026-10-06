/**
 * 覆盖 `canvas/timeline.ts` 的片段编辑纯函数：定位、分割与分割按钮可用性、缩略图画布尺寸、删除、换位、插入、裁剪、间隙。
 * 本地播放会话依赖 `<video>`，在 `CanvasPanel.test.tsx` 与真实窗口中验证。
 */

import { describe, expect, test } from 'bun:test'
import {
  canSplit,
  gapAt,
  insertClips,
  locate,
  MIN_CLIP,
  moveClip,
  splitAt,
  startsOf,
  thumbCanvas,
  totalOf,
  trimClip,
  withoutClip,
} from './timeline.ts'

const a = { path: 'a.mp4', in: 1, out: 3 }
const b = { path: 'b.mp4', in: 0, out: 4 }
const c = { path: 'a.mp4', in: 5, out: 6 }
const clips = [a, b, c]

describe('时间线：片段编辑', () => {
  test('起点、总长与定位：时刻换算为段序号与源时间，终点位于最后一段的出点', () => {
    expect(startsOf(clips)).toEqual([0, 2, 6])
    expect(totalOf(clips)).toBe(7)
    expect(locate(clips, 0)).toEqual({ index: 0, source: 1 })
    expect(locate(clips, 2.5)).toEqual({ index: 1, source: 0.5 })
    expect(locate(clips, 7)).toEqual({ index: 2, source: 6 })
    expect(locate([], 1)).toBeNull()
  })

  test('分割：在指定时刻一分为二，精确到毫秒；距两端不足最短段长时不分割', () => {
    expect(splitAt(clips, 3.0004)).toEqual([
      a,
      { path: 'b.mp4', in: 0, out: 1 },
      { path: 'b.mp4', in: 1, out: 4 },
      c,
    ])
    expect(splitAt(clips, 2 + MIN_CLIP / 2)).toBeNull()
    expect(splitAt([], 1)).toBeNull()
  })

  test('缩略图画布：宽高按同一倍数计算，节点中（块高 48）与全屏中（块高 72）均不拉伸；超宽时等比缩小', () => {
    const ratio = (s: { width: number; height: number }) => s.width / s.height
    expect(ratio(thumbCanvas(144, 48))).toBeCloseTo(144 / 48, 5)
    expect(ratio(thumbCanvas(460, 72))).toBeCloseTo(460 / 72, 5)
    const wide = thumbCanvas(8192, 72)
    expect(wide.width).toBe(4096)
    expect(ratio(wide)).toBeCloseTo(8192 / 72, 0)
  })

  test('分割按钮：播放经过片段交界时保持可用，停止后按停止位置判断', () => {
    // 从 0 播放到终点，逐帧（60 Hz）读取按钮状态：每一帧均须可用。
    for (let t = 0; t < totalOf(clips); t += 1 / 60) expect(canSplit(clips, t, true)).toBe(true)
    expect(canSplit(clips, 2 + MIN_CLIP / 2, false)).toBe(false)
    expect(canSplit(clips, 3, false)).toBe(true)
    expect(canSplit([], 0, true)).toBe(false)
  })

  test('删除、插入与换位；换位到原处时返回 null', () => {
    expect(withoutClip(clips, 1)).toEqual([a, c])
    expect(insertClips(clips, 1, [c])).toEqual([a, c, b, c])
    expect(moveClip(clips, 0, 3)).toEqual([b, c, a])
    expect(moveClip(clips, 2, 0)).toEqual([c, a, b])
    expect(moveClip(clips, 1, 1)).toBeNull()
    expect(moveClip(clips, 1, 2)).toBeNull()
  })

  test('裁剪：入点不小于 0、出点不超过源时长，段长不短于最短段长，精确到毫秒', () => {
    expect(trimClip(clips, 0, 'in', -2, 10)[0]).toEqual({ ...a, in: 0 })
    expect(trimClip(clips, 0, 'in', 2.99, 10)[0]).toEqual({ ...a, in: 2.9 })
    expect(trimClip(clips, 1, 'out', 9, 4.5)[1]).toEqual({ ...b, out: 4.5 })
    expect(trimClip(clips, 1, 'out', 1.23456, 4.5)[1]).toEqual({ ...b, out: 1.235 })
  })

  test('间隙：统计中点位于时刻之前的段，不计拖动中的段', () => {
    expect(gapAt(clips, 0.5)).toBe(0)
    expect(gapAt(clips, 4.5)).toBe(2)
    expect(gapAt(clips, 7)).toBe(3)
    expect(gapAt(clips, 4.5, 1)).toBe(1)
  })
})
