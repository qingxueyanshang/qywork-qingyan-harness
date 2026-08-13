/**
 * 原地打转的判定口径。覆盖 `progress.ts`。
 *
 * 这里最要紧的不是「能认出循环」，是**不能误判**：砍掉一个正常的长流程，
 * 用户看到的是「它自己停了、活没干完」，而且没有任何线索指向这条规则。
 * 所以下面「不该判」的用例比「该判」的多。
 */

import { describe, expect, test } from 'bun:test'
import {
  actionFingerprint,
  cycleFingerprint,
  type ProgressEvidence,
  repeatsNoProgress,
} from './progress.ts'

function ev(action: string, result: string, noProgress = true): ProgressEvidence {
  return { action, cycle: `${action}|${result}`, noProgress }
}

describe('指纹', () => {
  /** 参数键顺序不该改变指纹——同一次调用，JSON 序列化顺序可能不同。 */
  test('参数键顺序不影响动作指纹', () => {
    expect(actionFingerprint('read_file', { path: 'a.ts', limit: 5 })).toBe(
      actionFingerprint('read_file', { limit: 5, path: 'a.ts' }),
    )
  })

  test('参数值不同则指纹不同', () => {
    expect(actionFingerprint('read_file', { path: 'a.ts' })).not.toBe(
      actionFingerprint('read_file', { path: 'b.ts' }),
    )
  })

  /** 同样的动作、不同的结果 = 不同的周期。轮询类调用靠这条不被误判。 */
  test('结果不同则周期指纹不同，动作指纹相同', () => {
    const args = { command: 'ls' }
    const a = cycleFingerprint('run_command', args, { status: 'success', message: '2 项' })
    const b = cycleFingerprint('run_command', args, { status: 'success', message: '3 项' })
    expect(a).not.toBe(b)
    expect(actionFingerprint('run_command', args)).toBe(actionFingerprint('run_command', args))
  })

  test('嵌套对象也按键排序，不因序列化顺序抖动', () => {
    const x = cycleFingerprint('t', { o: { b: 1, a: 2 } }, { status: 'success' })
    const y = cycleFingerprint('t', { o: { a: 2, b: 1 } }, { status: 'success' })
    expect(x).toBe(y)
  })
})

describe('该判成打转的', () => {
  test('A,A,A —— 同样的调用同样的结果连着三次', () => {
    expect(repeatsNoProgress([ev('A', 'r'), ev('A', 'r'), ev('A', 'r')])).toBe(true)
  })

  test('A,B ×3 —— 宽度 2 的周期', () => {
    const cycle = [ev('A', 'r1'), ev('B', 'r2')]
    expect(repeatsNoProgress([...cycle, ...cycle, ...cycle])).toBe(true)
  })

  test('前面有正常进展，末尾开始打转也认得出来', () => {
    const h = [ev('X', 'ok', false), ev('Y', 'ok', false), ev('A', 'r'), ev('A', 'r'), ev('A', 'r')]
    expect(repeatsNoProgress(h)).toBe(true)
  })
})

describe('不该判成打转的', () => {
  test('不够三次', () => {
    expect(repeatsNoProgress([])).toBe(false)
    expect(repeatsNoProgress([ev('A', 'r')])).toBe(false)
    // **只有两次不判**：模型重新定位时再看一眼同一个目录是正常的。
    expect(repeatsNoProgress([ev('A', 'r'), ev('A', 'r')])).toBe(false)
  })

  /**
   * 轮询：同样的命令、不同的输出。等构建、等文件出现都是这个形状，
   * 判成打转会把一个正在生效的等待砍掉。
   */
  test('同样的动作但结果在变', () => {
    expect(repeatsNoProgress([ev('A', 'r1'), ev('A', 'r2'), ev('A', 'r3')])).toBe(false)
    // 前两次一样、第三次变了 —— 循环被打断。
    expect(repeatsNoProgress([ev('A', 'r1'), ev('A', 'r1'), ev('A', 'r2')])).toBe(false)
  })

  /**
   * 反复写同一个文件、每次内容不同：动作和结果都可能相同（工具只回「已写入」），
   * 但它确凿产生了副作用。`noProgress` 取执行器的事实，这条靠它挡住。
   */
  test('有副作用就不算空转，哪怕调用和结果一模一样', () => {
    const withEffect = [ev('A', 'r', false), ev('A', 'r', false), ev('A', 'r', false)]
    expect(repeatsNoProgress(withEffect)).toBe(false)
    // 只要有一次有副作用，整个周期就不成立。
    expect(repeatsNoProgress([ev('A', 'r'), ev('A', 'r'), ev('A', 'r', false)])).toBe(false)
  })

  test('宽度 2 的周期里换了一项就不算', () => {
    const cycle = [ev('A', 'r1'), ev('B', 'r2')]
    expect(repeatsNoProgress([...cycle, ...cycle, ev('A', 'r1'), ev('B', 'r3')])).toBe(false)
  })

  /** 宽度上限是 3：再宽的重复不像循环，误判代价更大。 */
  test('宽度 4 的周期不判', () => {
    const cycle = [ev('A', '1'), ev('B', '2'), ev('C', '3'), ev('D', '4')]
    expect(repeatsNoProgress([...cycle, ...cycle, ...cycle])).toBe(false)
    // 显式放宽上限就认得出来——说明不是逻辑不支持，是刻意不开。
    expect(repeatsNoProgress([...cycle, ...cycle, ...cycle], 4)).toBe(true)
  })

  /**
   * `A,B,A` 不算：宽度只能取 1（三项只够比一对），而末尾两项是 B,A——不同。
   * 第三次 A 是不是循环，要等它真的又跑出同样的结果才知道。**宁可晚一轮**。
   */
  test('周期只出现一次半不算', () => {
    expect(repeatsNoProgress([ev('A', 'r'), ev('B', 'r2'), ev('A', 'r')])).toBe(false)
    expect(repeatsNoProgress([ev('A', 'r'), ev('B', 'r2'), ev('C', 'r3')])).toBe(false)
  })
})
