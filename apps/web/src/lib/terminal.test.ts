/**
 * 覆盖范围：`terminal.ts` 按「id + 创建序号」分发终端事件。外壳以 `__TAURI_INTERNALS__` 模拟。
 *
 * 原始失败形状：「重开」用同一 id 关闭后立即重新打开，旧进程的残余输出与退出事件写入新终端，
 * 新终端随即显示为已退出。
 */

import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// `terminal.ts` 经由 store 入口导入，后者在加载时读取 `location`。
beforeAll(() => GlobalRegistrator.register({ url: 'http://localhost/' }))
afterAll(() => GlobalRegistrator.unregister())

const g = globalThis as Record<string, unknown>
const previous = g.__TAURI_INTERNALS__
afterEach(() => {
  g.__TAURI_INTERNALS__ = previous
})

test('重开后旧会话的残余输出与退出不写入新终端，新会话在打开返回前的输出照常写入', async () => {
  const callbacks: ((raw: unknown) => void)[] = []
  const listeners = new Map<string, (raw: unknown) => void>()
  const emit = (event: string, payload: unknown) => listeners.get(event)?.({ payload })
  let seq = 6
  let duringOpen: ((createdSeq: number) => void) | null = null
  g.__TAURI_INTERNALS__ = {
    transformCallback: (cb: (raw: unknown) => void) => callbacks.push(cb) - 1,
    invoke: async (cmd: string, args: { event?: string; handler?: number }) => {
      if (cmd === 'plugin:event|listen') {
        listeners.set(args.event!, callbacks[args.handler!]!)
        return
      }
      if (cmd === 'terminal_open') {
        const createdSeq = ++seq
        duringOpen?.(createdSeq)
        return { createdSeq, backlog: '' }
      }
      if (cmd === 'terminal_close') return
      throw new Error(`未预期命令：${cmd}`)
    },
  }
  const { closeTerminal, openTerminal } = await import('./terminal.ts')

  const first: string[] = []
  await openTerminal('t1', 'ws', '/w', 80, 24, { output: (d) => first.push(d), exit: () => {} })
  emit('terminal:output', { id: 't1', createdSeq: 7, data: 'a' })
  expect(first).toEqual(['a'])

  await closeTerminal('t1')
  const out: string[] = []
  const exits: (number | null)[] = []
  // 新会话在 `terminal_open` 返回之前输出提示符；旧会话的残余输出与退出在其前后到达。
  duringOpen = (createdSeq) => {
    emit('terminal:output', { id: 't1', createdSeq: 7, data: '旧输出' })
    emit('terminal:output', { id: 't1', createdSeq, data: 'PS>' })
    emit('terminal:exit', { id: 't1', createdSeq: 7, code: 0 })
  }
  await openTerminal('t1', 'ws', '/w', 80, 24, {
    output: (d) => out.push(d),
    exit: (code) => exits.push(code),
  })
  emit('terminal:output', { id: 't1', createdSeq: 7, data: '更晚的旧输出' })
  emit('terminal:output', { id: 't1', createdSeq: 8, data: ' ls' })

  expect(out).toEqual(['PS>', ' ls'])
  expect(exits).toEqual([])
})
