/**
 * 斜杠判定的口径。覆盖 `lib/slash.ts`。
 *
 * 命令表在 `commands.ts`，那个文件 import 图标（.tsx），测试加载它会去找
 * JSX runtime 然后炸掉。判定逻辑不该拖着一堆 SVG 才能被验证，所以拆了出来。
 */
import { describe, expect, test } from 'bun:test'
import { slashQuery } from './slash.ts'

describe('斜杠查询', () => {
  test('整段就是一个 /xxx 才算命令', () => {
    expect(slashQuery('/')).toBe('')
    expect(slashQuery('/com')).toBe('com')
    expect(slashQuery('/compact')).toBe('compact')
  })

  test('正文里的斜杠不弹面板', () => {
    // 路径：用户在描述要改哪个文件，不是要执行命令。
    expect(slashQuery('/compact 然后呢')).toBeNull()
    expect(slashQuery('看下 src/lib')).toBeNull()
    expect(slashQuery('')).toBeNull()
    // 换行也算空白：多行草稿里第一行像命令也不该弹。
    expect(slashQuery('/clear\n第二行')).toBeNull()
  })
})
