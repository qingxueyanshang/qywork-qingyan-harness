/**
 * 覆盖范围：`comment-style.ts` 的注释提取与词表判定，以及全仓注释的一次全量扫描。
 *
 * 这份测试是 B10 的执行者：口水话进不了仓库靠它，不靠人在评审里逐条看。
 * 失败信息给的是「文件:行 + 命中词 + 改写方向」，不需要回头查规则原文。
 */

import { describe, expect, test } from 'bun:test'
import { extractComments, scanAll } from './comment-style.ts'

describe('注释提取', () => {
  test('行注释与块注释都取得到，行号对得上', () => {
    const src = ['const a = 1 // 尾注释', '/*', ' * 块注释', ' */', 'const b = 2'].join('\n')
    expect(extractComments(src, true)).toEqual([
      { line: 1, text: ' 尾注释' },
      { line: 2, text: '' },
      { line: 3, text: ' * 块注释' },
      { line: 4, text: ' ' },
    ])
  })

  test('字符串里的 // 不是注释 —— 否则界面文案会被拖进这份检查', () => {
    const src = `const url = 'https://example.com/我们'`
    expect(extractComments(src, true)).toEqual([])
  })

  test('CSS 只认块注释', () => {
    const src = 'a { color: red } /* 注释 */'
    expect(extractComments(src, false)).toEqual([{ line: 1, text: ' 注释 ' }])
  })
})

describe('全仓注释文体', () => {
  /**
   * 命中即失败，没有豁免名单。
   *
   * 改写方向在 `comment-style.ts` 的词表里逐条写着；改不动通常说明这句话本身
   * 不该在注释里（B10：只写用途、坑、边界）。
   */
  test('注释里不出现口语、第一人称自述、拟人比喻、场景铺陈与外部出处', () => {
    const lines = scanAll().map((v) => `${v.file}:${v.line} 「${v.word}」 → ${v.hint}`)
    expect(lines).toEqual([])
  })
})
