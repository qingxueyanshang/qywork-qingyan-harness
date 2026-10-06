/**
 * 斜杠判定规则。覆盖 `lib/slash.ts`。
 *
 * 命令表位于 `commands.ts`，该文件 import 图标（.tsx），测试加载它时会查找
 * JSX runtime 并失败。判定逻辑不应依赖全部 SVG 才能验证，因此单独拆出。
 */
import { describe, expect, test } from 'bun:test'
import { slashCall, slashDispatch, slashQuery } from './slash.ts'

describe('斜杠查询', () => {
  test('仅当整段恰好是一个 /xxx 时视为命令', () => {
    expect(slashQuery('/')).toBe('')
    expect(slashQuery('/com')).toBe('com')
    expect(slashQuery('/compact')).toBe('compact')
  })

  test('正文中的斜杠不弹出面板', () => {
    // 路径：用户在描述要修改的文件，不是要执行命令。
    expect(slashQuery('/compact 然后呢')).toBeNull()
    expect(slashQuery('看下 src/lib')).toBeNull()
    expect(slashQuery('')).toBeNull()
    // 换行也属于空白：多行草稿的第一行即使形似命令也不弹出面板。
    expect(slashQuery('/new\n第二行')).toBeNull()
  })
})

/**
 * 回车时的判定。与 `slashQuery` 职责不同：`slashQuery` 决定补全面板是否弹出
 * （输入过程中即需判断，出现空格即收起），此处判定整段输入是否为一条带参数的命令
 * （此时参数已输入完毕，包含空格是常态）。
 */
describe('带参数的命令', () => {
  test('第一个词是命令名，其余整段是参数', () => {
    expect(slashCall('/goal 把测试跑绿')).toEqual({ name: 'goal', arg: '把测试跑绿' })
  })

  /**
   * 不解析第二个参数：`/goal 3 个 bug 都修掉` 中的 3 无法确定是轮数还是正文。
   * 推测错误会按用户未指定的数值开始执行，而用户无从得知。
   */
  test('参数中的数字不被拆分为第二个参数', () => {
    expect(slashCall('/goal 3 个 bug 都修掉')?.arg).toBe('3 个 bug 都修掉')
  })

  test('多行参数原样保留', () => {
    expect(slashCall('/goal 甲\n乙')?.arg).toBe('甲\n乙')
  })

  /** 不带参数的命令 arg 为空字符串：调用方据此决定「填入草稿等待用户输入」还是「直接执行」。 */
  test('不带参数的命令，其参数为空字符串而不是 null', () => {
    expect(slashCall('/goal')).toEqual({ name: 'goal', arg: '' })
    expect(slashCall('/goal   ')).toEqual({ name: 'goal', arg: '' })
  })

  test('不以斜杠开头的输入一律不视为命令', () => {
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
    { slash: 'role', arg: { placeholder: '角色描述' } },
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
    expect(slashDispatch('/role 检查这次改动', commands)).toMatchObject({
      kind: 'run',
      arg: '检查这次改动',
    })
  })

  test('未知命令和无参命令后的额外正文仍作为消息', () => {
    expect(slashDispatch('/unknown', commands).kind).toBe('message')
    expect(slashDispatch('/compact 然后呢', commands).kind).toBe('message')
  })
})
