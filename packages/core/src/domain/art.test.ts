/** 覆盖范围：`art.ts` 的尺寸参数、viewport 标签的读取与写入。 */

import { describe, expect, test } from 'bun:test'
import {
  ART_DEFAULT_SIZE,
  artSizeOf,
  artViewportOf,
  insertAfterHead,
  withArtViewport,
} from './art.ts'

describe('Art：viewport', () => {
  test('读取 viewport 声明的宽高；属性顺序、引号与大小写不影响结果', () => {
    expect(
      artViewportOf('<head><meta name="viewport" content="width=1280, height=720"></head>'),
    ).toEqual({ w: 1280, h: 720 })
    expect(artViewportOf("<META content='height=1280,width=720' NAME=viewport>")).toEqual({
      w: 720,
      h: 1280,
    })
  })

  test('没有标签、只声明宽度、取值越界或为 device-width 时为 null', () => {
    expect(artViewportOf('<head></head>')).toBeNull()
    expect(artViewportOf('<meta name="viewport" content="width=1280">')).toBeNull()
    expect(artViewportOf('<meta name="viewport" content="width=0, height=720">')).toBeNull()
    expect(artViewportOf('<meta name="viewport" content="width=9000, height=720">')).toBeNull()
    expect(
      artViewportOf('<meta name="viewport" content="width=device-width, height=720">'),
    ).toBeNull()
  })

  test('写入：已有标签时替换；否则依次放在 head、html、doctype 之后或文档开头', () => {
    const size = { w: 720, h: 1280 }
    const tag = '<meta name="viewport" content="width=720, height=1280">'
    expect(
      withArtViewport('<head><meta name="viewport" content="width=device-width"></head>', size),
    ).toBe(`<head>${tag}</head>`)
    expect(
      withArtViewport('<!doctype html><html lang="zh"><head><title>t</title></head>', size),
    ).toBe(`<!doctype html><html lang="zh"><head>${tag}<title>t</title></head>`)
    expect(withArtViewport('<!doctype html><html><body></body></html>', size)).toBe(
      `<!doctype html><html>${tag}<body></body></html>`,
    )
    expect(withArtViewport('<!DOCTYPE html><body></body>', size)).toBe(
      `<!DOCTYPE html>${tag}<body></body>`,
    )
    expect(withArtViewport('<p>x</p>', size)).toBe(`${tag}<p>x</p>`)
    expect(artViewportOf(withArtViewport('<head></head>', size))).toEqual(size)
  })

  test('<header> 不被当作 <head>', () => {
    expect(insertAfterHead('<header>x</header>', '<i>')).toBe('<i><header>x</header>')
  })
})

describe('Art：尺寸参数', () => {
  test('可选值按宽x高解析；缺省或不在可选值中时为 1280×720', () => {
    expect(artSizeOf({ size: '720x1280' })).toEqual({ w: 720, h: 1280 })
    expect(artSizeOf({})).toEqual(ART_DEFAULT_SIZE)
    expect(artSizeOf({ size: '333x333' })).toEqual(ART_DEFAULT_SIZE)
  })
})
