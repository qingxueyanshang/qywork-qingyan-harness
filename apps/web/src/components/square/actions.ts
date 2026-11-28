/**
 * 条目的操作，按类型一个处理器（新增类型时编译器要求在此补一项）。列表行与详情页调用同一张表。
 */

import type { SquareDetail, SquareKind, SquareMetaByKind } from '@qywork/core'
import { createSignal } from 'solid-js'
import { openFileInPanel } from '../../lib/store/files.ts'
import { askInChat, explainApiError } from '../../lib/store/index.ts'
import { installSquareItem, setSquareOpen } from '../../lib/store/square.ts'

export interface SquareAction {
  label: string
  /** 需要详情才能判定的条件；带条件的操作只在详情页显示。 */
  when?: (d: SquareDetail) => boolean
  /**
   * 执行操作，返回结果的一句话；关闭弹窗的操作返回 null。
   * `detail` 取得条目详情：详情页传入已读取的详情，列表行在需要时读取。
   */
  run: (id: string, detail: () => Promise<SquareDetail>) => Promise<string | null>
}

/** 文字放入输入框后关闭弹窗：输入框在弹窗之下。 */
function toComposer(text: string): null {
  askInChat(text)
  setSquareOpen(false)
  return null
}

const install = (label: string): SquareAction => ({
  label,
  run: async (id) => (await installSquareItem(id)).message,
})

export const ACTIONS: Record<SquareKind, SquareAction> = {
  work: {
    label: '使用提示词',
    when: (d) => Boolean((d.meta as SquareMetaByKind['work']).prompt),
    run: async (_id, detail) =>
      toComposer(((await detail()).meta as SquareMetaByKind['work']).prompt ?? ''),
  },
  canvas: {
    label: '导入',
    run: async (id) => {
      const done = await installSquareItem(id)
      if (!done.canvas) return done.message
      openFileInPanel(done.canvas)
      setSquareOpen(false)
      return null
    },
  },
  plugin: install('安装'),
  skill: install('安装'),
  mcp: install('添加'),
  pet: install('添加'),
  skin: install('应用'),
}

/** 一次操作的进行状态与结果。结果显示在发起操作的那一行或那一页。 */
export function createActionRunner() {
  const [busy, setBusy] = createSignal(false)
  const [result, setResult] = createSignal<{ ok: boolean; text: string } | null>(null)
  const run = async (action: SquareAction, id: string, detail: () => Promise<SquareDetail>) => {
    setBusy(true)
    setResult(null)
    try {
      const text = await action.run(id, detail)
      if (text) setResult({ ok: true, text })
    } catch (e) {
      setResult({ ok: false, text: explainApiError(e, `${action.label}失败`) })
    } finally {
      setBusy(false)
    }
  }
  return { busy, result, run }
}
