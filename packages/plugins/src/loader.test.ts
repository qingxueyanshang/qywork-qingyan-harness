/**
 * 插件返回值的归一化。
 *
 * 插件是第三方代码，返回值可能是任意形状，因此必须在信任边界上归一化。
 * 归一化后的消息是用户与插件作者唯一能看到的信息，
 * 其表述是否清楚直接决定排查出错插件所需的时间。
 */

import { describe, expect, test } from 'bun:test'
import { normalizeOutcome } from './loader.ts'

describe('拒绝时说明原因', () => {
  /**
   * 实测情形：插件返回结构完整的 `{content: "..."}` 时，界面只显示 `✗ 失败`。
   * 插件作者无法判断是返回形状错误还是插件逻辑失败，而两者的排查方向相反。
   *
   * fail-closed 本身正确，需要保证的是拒绝时说明原因。
   */
  test('缺少 status 时说明缺少的字段与实际收到的字段', () => {
    const out = normalizeOutcome({ content: '一些内容', other: 1 }, 'probe_net')
    expect(out.status).toBe('failure')
    expect(out.message).toContain('status')
    // 列出实际收到的字段：作者可直接看出返回的是 content 而不是 message。
    expect(out.message).toContain('content')
    // 同时说明期望的形状，否则作者知道有误也无法确定应如何修改。
    expect(out.message).toContain('success')
  })

  test('status 为其他值时原样报告该值', () => {
    const out = normalizeOutcome({ status: 'ok' }, 't')
    expect(out.status).toBe('failure')
    expect(out.message).toContain('"ok"')
  })

  /** 非对象返回值同样须说明实际类型，不能只报告「非对象」。 */
  test('非对象返回值附带实际类型', () => {
    expect(normalizeOutcome('一段文字', 't').message).toContain('string')
    expect(normalizeOutcome(undefined, 't').message).toContain('undefined')
    expect(normalizeOutcome(null, 't').message).toContain('object')
  })

  /**
   * 插件提供了 message 时使用插件的 message：它是对失败原因的第一手描述，
   * 比依据形状推断的准确。本地补充的说明只在插件未提供时使用。
   */
  test('插件提供了 message 时不覆盖', () => {
    const out = normalizeOutcome({ status: 'failure', message: '目标文件不存在' }, 't')
    expect(out.message).toBe('目标文件不存在')
  })

  test('空 message 视为未提供，仍然补充说明', () => {
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

  test('成功但未提供 message 时使用中性文字', () => {
    expect(normalizeOutcome({ status: 'success' }, 't').message).toBe('完成')
  })

  /**
   * `executed` 缺省取 true：插件已经执行，无法判定时按有副作用处理。
   * 写成 `!== false` 而不是 `Boolean(...)`：后者会把「未填写」也视为 false，
   * 使确实修改了文件的插件被记为「未执行」。
   */
  test('executed 未填写时视为 true，只有填写 false 时为 false', () => {
    expect(normalizeOutcome({ status: 'success' }, 't').executed).toBe(true)
    expect(normalizeOutcome({ status: 'success', executed: false }, 't').executed).toBe(false)
  })

  test('data 只在为对象时保留', () => {
    expect(normalizeOutcome({ status: 'success', data: { a: 1 } }, 't').data).toEqual({ a: 1 })
    expect(normalizeOutcome({ status: 'success', data: '不是对象' }, 't').data).toBeUndefined()
  })
})
