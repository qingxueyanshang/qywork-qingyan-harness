/**
 * 覆盖范围：`terminal.ts` 按「id + 创建序号」分发终端事件，按输出偏移与回放的结束偏移去重。
 * 外壳以 `__TAURI_INTERNALS__` 模拟；事件监听在模块中只注册一次，因此各用例共用同一个模拟。
 *
 * 原始失败形状：
 * - 「重开」用同一 id 关闭后立即重新打开，旧进程的残余输出与退出事件写入新终端，新终端随即显示为已退出；
 * - 重新接入时，回放范围内的输出事件早于 `terminal_open` 返回到达，先被写入一次，返回后回放又写入一次，
 *   且回放位于其后的输出之后。
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// `terminal.ts` 经由 store 入口导入，后者在加载时读取 `location`。
beforeAll(() => GlobalRegistrator.register({ url: 'http://localhost/' }))
afterAll(() => GlobalRegistrator.unregister())

interface Opened {
  createdSeq: number
  backlog: string
  end: number
}

const g = globalThis as Record<string, unknown>
const previous = g.__TAURI_INTERNALS__
const callbacks: ((raw: unknown) => void)[] = []
const listeners = new Map<string, (raw: unknown) => void>()
const emit = (event: string, payload: unknown) => listeners.get(event)?.({ payload })
/** 每个用例设置：`terminal_open` 被调用时执行，返回值即该命令的结果。 */
let onOpen: (id: string) => Opened = () => {
  throw new Error('未设置 terminal_open 的结果')
}

beforeAll(() => {
  g.__TAURI_INTERNALS__ = {
    transformCallback: (cb: (raw: unknown) => void) => callbacks.push(cb) - 1,
    invoke: async (cmd: string, args: { event?: string; handler?: number; id?: string }) => {
      if (cmd === 'plugin:event|listen') {
        listeners.set(args.event!, callbacks[args.handler!]!)
        return
      }
      if (cmd === 'terminal_open') return onOpen(args.id!)
      if (cmd === 'terminal_close') return
      throw new Error(`未预期命令：${cmd}`)
    },
  }
})
afterAll(() => {
  g.__TAURI_INTERNALS__ = previous
})

const output = (id: string, createdSeq: number, offset: number, data: string) =>
  emit('terminal:output', { id, createdSeq, offset, data })

test('重开后旧会话的残余输出与退出不写入新终端，新会话在打开返回前的输出照常写入', async () => {
  const { closeTerminal, openTerminal } = await import('./terminal.ts')
  let seq = 6
  let duringOpen: ((createdSeq: number) => void) | null = null
  onOpen = () => {
    const createdSeq = ++seq
    duringOpen?.(createdSeq)
    return { createdSeq, backlog: '', end: 0 }
  }

  const first: string[] = []
  await openTerminal('t1', 'ws', '/w', 80, 24, { output: (d) => first.push(d), exit: () => {} })
  output('t1', 7, 0, 'a')
  expect(first).toEqual(['a'])

  await closeTerminal('t1')
  const out: string[] = []
  const exits: (number | null)[] = []
  // 新会话在 `terminal_open` 返回之前输出提示符；旧会话的残余输出与退出在其前后到达。
  duringOpen = (createdSeq) => {
    output('t1', 7, 1, '旧输出')
    output('t1', createdSeq, 0, 'PS>')
    emit('terminal:exit', { id: 't1', createdSeq: 7, code: 0 })
  }
  await openTerminal('t1', 'ws', '/w', 80, 24, {
    output: (d) => out.push(d),
    exit: (code) => exits.push(code),
  })
  output('t1', 7, 10, '更晚的旧输出')
  output('t1', 8, 3, ' ls')

  expect(out).toEqual(['PS>', ' ls'])
  expect(exits).toEqual([])
})

test('重新接入时回放先写入，早于打开返回到达的回放范围内输出不重复写入', async () => {
  const { openTerminal } = await import('./terminal.ts')
  // 回放 `abcd` 的结束偏移为 4：前两块已在回放中，第三块在快照之后。
  onOpen = () => {
    output('t2', 3, 0, 'ab')
    output('t2', 3, 2, 'cd')
    output('t2', 3, 4, 'ef')
    return { createdSeq: 3, backlog: 'abcd', end: 4 }
  }
  const out: string[] = []
  await openTerminal('t2', 'ws', '/w', 80, 24, { output: (d) => out.push(d), exit: () => {} })
  expect(out).toEqual(['abcd', 'ef'])
})

test('跨越结束偏移的输出只写入偏移不小于它的部分，打开返回之后到达的输出同样按偏移筛选', async () => {
  const { openTerminal } = await import('./terminal.ts')
  onOpen = () => {
    output('t3', 5, 6, 'gh')
    output('t3', 5, 8, 'ij')
    return { createdSeq: 5, backlog: '…abcdefgh', end: 8 }
  }
  const out: string[] = []
  await openTerminal('t3', 'ws', '/w', 80, 24, { output: (d) => out.push(d), exit: () => {} })
  // 回放范围内的输出晚于打开返回到达：已在回放中，不写入。
  output('t3', 5, 4, 'ef')
  output('t3', 5, 10, 'kl')
  expect(out.join('')).toBe('…abcdefghijkl')
  expect(out).toEqual(['…abcdefgh', 'ij', 'kl'])
})

test('新建的会话没有回放，打开返回之前与之后的输出依次写入', async () => {
  const { openTerminal } = await import('./terminal.ts')
  onOpen = () => {
    output('t4', 9, 0, 'PS>')
    return { createdSeq: 9, backlog: '', end: 0 }
  }
  const out: string[] = []
  await openTerminal('t4', 'ws', '/w', 80, 24, { output: (d) => out.push(d), exit: () => {} })
  output('t4', 9, 3, ' dir')
  expect(out).toEqual(['PS>', ' dir'])
})
