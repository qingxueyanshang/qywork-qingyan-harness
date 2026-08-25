/**
 * 插件返回值的归一化。
 *
 * 插件是第三方代码，返回什么形状都有可能，所以**必须在信任边界上收敛**。
 * 但收敛之后的那条消息是**用户和插件作者唯一能看到的信息**——
 * 它说得清不清楚，直接决定一个装错的插件要查十秒还是查半小时。
 */

import { describe, expect, test } from 'bun:test'
import { normalizeOutcome } from './loader.ts'

describe('拒绝要说出理由', () => {
  /**
   * 这条是这个文件存在的直接原因。
   *
   * 实测形状：插件返回一个结构正常的 `{content: "..."}`，界面上只显示 `✗ 失败`
   * 两个字。插件作者无从判断是形状写错了，
   * 还是插件逻辑真的失败了——而这两件事的排查方向完全相反。
   *
   * fail-closed 本身是对的，要修的是「拒绝时不说为什么」。
   * 与「MCP server 未运行」不带死因是同一类问题，那一处已经修过。
   */
  test('缺 status 时说清缺的是什么、拿到的是什么', () => {
    const out = normalizeOutcome({ content: '一些内容', other: 1 }, 'probe_net')
    expect(out.status).toBe('failure')
    expect(out.message).toContain('status')
    // 把实际拿到的字段列出来——作者一眼就能看出自己写的是 content 不是 message。
    expect(out.message).toContain('content')
    // 还要说清期望的形状，否则知道错了也不知道该改成什么。
    expect(out.message).toContain('success')
  })

  test('status 是个别的值时把那个值原样报出来', () => {
    const out = normalizeOutcome({ status: 'ok' }, 't')
    expect(out.status).toBe('failure')
    expect(out.message).toContain('"ok"')
  })

  /** 非对象返回也要说清拿到的是什么类型，不能只说「非对象」。 */
  test('非对象返回带上实际类型', () => {
    expect(normalizeOutcome('一段文字', 't').message).toContain('string')
    expect(normalizeOutcome(undefined, 't').message).toContain('undefined')
    expect(normalizeOutcome(null, 't').message).toContain('object')
  })

  /**
   * 插件自己给了 message 就用它的——那是对失败原因的第一手描述，
   * 比从形状上推断的准确。本地补的解释只在它没给时兜底。
   */
  test('插件给了 message 就不覆盖它', () => {
    const out = normalizeOutcome({ status: 'failure', message: '目标文件不存在' }, 't')
    expect(out.message).toBe('目标文件不存在')
  })

  test('空 message 视同没给，仍然补解释', () => {
    const out = normalizeOutcome({ status: 'failure', message: '' }, 't')
    expect(out.message.length).toBeGreaterThan(0)
    expect(out.message).not.toBe('失败')
  })
})

describe('成功路径', () => {
  test('status=success 原样通过', () => {
    const out = normalizeOutcome({ status: 'success', message: '好了' }, 't')
    expect(out).toMatchObject({ status: 'success', message: '好了' })
  })

  test('成功但没给 message 时给一个中性的', () => {
    expect(normalizeOutcome({ status: 'success' }, 't').message).toBe('完成')
  })

  /**
   * `executed` 缺省取 true：插件已经跑过了，无法判定时保守假设它有副作用。
   * 写成 `!== false` 而不是 `Boolean(...)`——后者会把「没填」也当成 false，
   * 因此一个真的改了文件的插件会被记成「没执行」。
   */
  test('executed 没填时按 true，填了 false 才是 false', () => {
    expect(normalizeOutcome({ status: 'success' }, 't').executed).toBe(true)
    expect(normalizeOutcome({ status: 'success', executed: false }, 't').executed).toBe(false)
  })

  test('data 只在是对象时带上', () => {
    expect(normalizeOutcome({ status: 'success', data: { a: 1 } }, 't').data).toEqual({ a: 1 })
    expect(normalizeOutcome({ status: 'success', data: '不是对象' }, 't').data).toBeUndefined()
  })
})
