/**
 * 斜杠判定的口径。覆盖 `lib/slash.ts`。
 *
 * 命令表在 `commands.ts`，那个文件 import 图标（.tsx），测试加载它会去找
 * JSX runtime 并失败。判定逻辑不该拖着整批 SVG 才能被验证，所以拆了出来。
 */
import { describe, expect, test } from 'bun:test'
import { slashCall, slashDispatch, slashQuery } from './slash.ts'

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
    expect(slashQuery('/new\n第二行')).toBeNull()
  })
})

/**
 * 回车那一刻的判定。和 `slashQuery` 是两件事——那个管补全面板弹不弹
 * （打到一半就要判，带空格就收起来），这个管「这句话是不是一条带参数的命令」
 * （那时候参数已经打完了，带空格才是常态）。
 */
describe('带参数的命令', () => {
  test('第一个词是命令名，其余整段是参数', () => {
    expect(slashCall('/goal 把测试跑绿')).toEqual({ name: 'goal', arg: '把测试跑绿' })
  })

  /**
   * **不解析第二个参数。** `/goal 3 个 bug 都修掉` 里的 3 是轮数还是正文？
   * 猜错一次就是按一个用户没说过的数开跑，而他不会知道。
   */
  test('参数里的数字不被当成第二个参数切走', () => {
    expect(slashCall('/goal 3 个 bug 都修掉')?.arg).toBe('3 个 bug 都修掉')
  })

  test('多行参数原样保留', () => {
    expect(slashCall('/goal 甲\n乙')?.arg).toBe('甲\n乙')
  })

  /** 光杆命令 arg 是空串：调用方据此决定「填进草稿等用户打字」还是「直接跑」。 */
  test('光杆命令的参数是空串，不是 null', () => {
    expect(slashCall('/goal')).toEqual({ name: 'goal', arg: '' })
    expect(slashCall('/goal   ')).toEqual({ name: 'goal', arg: '' })
  })

  test('不是斜杠开头的一律不算', () => {
    expect(slashCall('看下 src/lib')).toBeNull()
    expect(slashCall('')).toBeNull()
    expect(slashCall('/')).toBeNull()
  })
})

describe('提交分派', () => {
  const commands = [
    { slash: 'compact' },
    { slash: 'new' },
    { slash: 'goal', arg: { placeholder: '目标' } },
  ]

  test('无参命令通过发送按钮提交时也直接执行', () => {
    expect(slashDispatch('/compact', commands).kind).toBe('run')
    expect(slashDispatch('/new   ', commands).kind).toBe('run')
  })

  test('带参命令缺参数时等待输入，参数完整时执行', () => {
    expect(slashDispatch('/goal', commands).kind).toBe('await_argument')
    const dispatch = slashDispatch('/goal 把测试跑绿', commands)
    expect(dispatch.kind).toBe('run')
    expect(dispatch.kind === 'run' && dispatch.arg).toBe('把测试跑绿')
  })

  test('未知命令和无参命令后的额外正文仍作为消息', () => {
    expect(slashDispatch('/unknown', commands).kind).toBe('message')
    expect(slashDispatch('/compact 然后呢', commands).kind).toBe('message')
  })
})
