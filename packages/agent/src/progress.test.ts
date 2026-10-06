/**
 * 连续无进展的判定口径。覆盖 `progress.ts`。
 *
 * 首要目标不是识别循环，而是避免误判：中止一个正常的长流程时，
 * 用户只看到任务自行停止且未完成，没有任何线索指向本规则。
 * 因此「不应判定」的用例多于「应判定」的用例。
 */

import { describe, expect, test } from 'bun:test'
import {
  cycleFingerprint,
  MAX_CYCLE_WIDTH,
  type ProgressEvidence,
  repeatsNoProgress,
} from './progress.ts'

function ev(action: string, result: string, noProgress = true): ProgressEvidence {
  return { cycle: `${action}|${result}`, noProgress }
}

describe('指纹', () => {
  /** 参数键顺序不应改变指纹：同一次调用的 JSON 序列化顺序可能不同。 */
  test('参数键顺序不影响周期指纹', () => {
    expect(cycleFingerprint('read_file', { path: 'a.ts', limit: 5 }, { status: 'success' })).toBe(
      cycleFingerprint('read_file', { limit: 5, path: 'a.ts' }, { status: 'success' }),
    )
  })

  test('参数值不同则指纹不同', () => {
    expect(cycleFingerprint('read_file', { path: 'a.ts' }, { status: 'success' })).not.toBe(
      cycleFingerprint('read_file', { path: 'b.ts' }, { status: 'success' }),
    )
  })

  test('未执行的参数校验失败按错误判定重复，改变参数但未解决错误不计为进展', () => {
    const outcome = {
      status: 'failure',
      executed: false,
      errorKind: 'invalid_tool_arguments',
      message: '缺少必填参数：path、content',
    }
    const first = cycleFingerprint('write_file', {}, outcome)
    expect(cycleFingerprint('write_file', { attempt: 2 }, outcome)).toBe(first)
    // 已补齐部分必填项，校验结果改变，允许继续修正。
    expect(
      cycleFingerprint(
        'write_file',
        { path: 'a' },
        { ...outcome, message: '缺少必填参数：content' },
      ),
    ).not.toBe(first)
    expect(cycleFingerprint('other_tool', {}, outcome)).not.toBe(first)
  })

  test('不把权限拒绝、已执行或执行事实未知的失败合并成同一参数错误', () => {
    for (const outcome of [
      { status: 'failure', executed: false, errorKind: 'permission_denied' },
      { status: 'failure', executed: true, errorKind: 'invalid_tool_arguments' },
      { status: 'failure', errorKind: 'invalid_tool_arguments' },
      { status: 'success', executed: false, errorKind: 'invalid_tool_arguments' },
    ]) {
      expect(cycleFingerprint('tool', { path: 'a' }, outcome)).not.toBe(
        cycleFingerprint('tool', { path: 'b' }, outcome),
      )
    }
  })

  /** 动作相同、结果不同即为不同的周期。轮询类调用依靠此规则避免误判。 */
  test('结果不同则周期指纹不同', () => {
    const args = { command: 'ls' }
    const a = cycleFingerprint('run_command', args, { status: 'success', message: '2 项' })
    const b = cycleFingerprint('run_command', args, { status: 'success', message: '3 项' })
    expect(a).not.toBe(b)
  })

  test('模型可见的执行事实或资源变化会改变周期', () => {
    const args = { path: 'a.txt' }
    const base = { status: 'success', message: '读取完成' }
    expect(cycleFingerprint('read_file', args, { ...base, executed: false })).not.toBe(
      cycleFingerprint('read_file', args, { ...base, executed: true }),
    )
    expect(
      cycleFingerprint('read_file', args, {
        ...base,
        resources: [{ resourceId: 'rs_a' }],
      }),
    ).not.toBe(
      cycleFingerprint('read_file', args, {
        ...base,
        resources: [{ resourceId: 'rs_b' }],
      }),
    )
  })

  test('嵌套对象同样按键排序，不受序列化顺序影响', () => {
    const x = cycleFingerprint('t', { o: { b: 1, a: 2 } }, { status: 'success' })
    const y = cycleFingerprint('t', { o: { a: 2, b: 1 } }, { status: 'success' })
    expect(x).toBe(y)
  })

  /** 指纹是定长摘要：图片结果的 base64 不得原样进入证据数组。 */
  test('大结果不以原文进入指纹，相同图片指纹相等、不同图片指纹不等', () => {
    const big = 'A'.repeat(100_000)
    const of = (bytes: string) =>
      cycleFingerprint(
        'read_file',
        { path: 'a.png' },
        { status: 'success', data: { images: [{ data: bytes, mime: 'image/png' }] } },
      )
    expect(of(big).length).toBeLessThan(64)
    expect(of(big)).toBe(of(big))
    expect(of(big)).not.toBe(of(`${big}B`))
  })
})

describe('按两次判定', () => {
  test('相同调用与相同结果连续两次：按 2 次判定成立，按 3 次判定不成立', () => {
    const h = [ev('A', 'r'), ev('A', 'r')]
    expect(repeatsNoProgress(h, MAX_CYCLE_WIDTH, 2)).toBe(true)
    expect(repeatsNoProgress(h)).toBe(false)
  })
})

describe('应判定为无进展', () => {
  test('A,A,A：相同调用与相同结果连续三次', () => {
    expect(repeatsNoProgress([ev('A', 'r'), ev('A', 'r'), ev('A', 'r')])).toBe(true)
  })

  test('A,B ×3：宽度为 2 的周期', () => {
    const cycle = [ev('A', 'r1'), ev('B', 'r2')]
    expect(repeatsNoProgress([...cycle, ...cycle, ...cycle])).toBe(true)
  })

  test('前段有正常进展时，仍能识别末尾的无进展循环', () => {
    const h = [ev('X', 'ok', false), ev('Y', 'ok', false), ev('A', 'r'), ev('A', 'r'), ev('A', 'r')]
    expect(repeatsNoProgress(h)).toBe(true)
  })
})

describe('不应判定为无进展', () => {
  test('不足三次', () => {
    expect(repeatsNoProgress([])).toBe(false)
    expect(repeatsNoProgress([ev('A', 'r')])).toBe(false)
    // 只有两次时不判定：模型重新定位时再次查看同一个目录属于正常行为。
    expect(repeatsNoProgress([ev('A', 'r'), ev('A', 'r')])).toBe(false)
  })

  /**
   * 轮询：命令相同、输出不同。等待构建、等待文件出现都属于这种形态，
   * 判定为无进展会中止一个有效的等待。
   */
  test('动作相同但结果变化', () => {
    expect(repeatsNoProgress([ev('A', 'r1'), ev('A', 'r2'), ev('A', 'r3')])).toBe(false)
    // 前两次相同、第三次变化：不构成循环。
    expect(repeatsNoProgress([ev('A', 'r1'), ev('A', 'r1'), ev('A', 'r2')])).toBe(false)
  })

  /**
   * 反复写入同一个文件、每次内容不同：动作与结果都可能相同（工具只返回「已写入」），
   * 但确实产生了副作用。`noProgress` 取自执行器给出的事实，本用例依靠它排除误判。
   */
  test('有副作用即不计为无进展，即使调用与结果完全相同', () => {
    const withEffect = [ev('A', 'r', false), ev('A', 'r', false), ev('A', 'r', false)]
    expect(repeatsNoProgress(withEffect)).toBe(false)
    // 只要有一次产生副作用，整个周期即不成立。
    expect(repeatsNoProgress([ev('A', 'r'), ev('A', 'r'), ev('A', 'r', false)])).toBe(false)
  })

  test('宽度为 2 的周期中有一项不同即不成立', () => {
    const cycle = [ev('A', 'r1'), ev('B', 'r2')]
    expect(repeatsNoProgress([...cycle, ...cycle, ev('A', 'r1'), ev('B', 'r3')])).toBe(false)
  })

  /** 宽度上限为 3：更宽的重复难以确认为循环，误判代价更大。 */
  test('宽度为 4 的周期不判定', () => {
    const cycle = [ev('A', '1'), ev('B', '2'), ev('C', '3'), ev('D', '4')]
    expect(repeatsNoProgress([...cycle, ...cycle, ...cycle])).toBe(false)
    // 显式放宽上限即可识别：逻辑支持该宽度，只是有意不启用。
    expect(repeatsNoProgress([...cycle, ...cycle, ...cycle], 4)).toBe(true)
  })

  /**
   * `A,B,A` 不成立：宽度只能取 1（三项只够比较一对），而末尾两项 B,A 不同。
   * 第三次 A 是否构成循环，要等它再次执行并得到相同的结果才能确定；宁可晚一轮判定。
   */
  test('周期只出现一次半时不成立', () => {
    expect(repeatsNoProgress([ev('A', 'r'), ev('B', 'r2'), ev('A', 'r')])).toBe(false)
    expect(repeatsNoProgress([ev('A', 'r'), ev('B', 'r2'), ev('C', 'r3')])).toBe(false)
  })
})
