import {
  SQUARE_KIND_LABEL,
  type SquareDetail,
  type SquareKind,
  type SquareMetaByKind,
} from '@qywork/core'
import { createResource, createSignal, Show } from 'solid-js'
import { openFileInPanel } from '../../lib/store/files.ts'
import { askInChat, explainApiError } from '../../lib/store/index.ts'
import { installSquareItem, setSquareOpen, squareDetail } from '../../lib/store/square.ts'
import { IconChevron } from '../Icons.tsx'
import { PREVIEWS } from './previews.tsx'

/** 条目的操作：按钮名称与执行；返回结果的一句话，关闭弹窗的操作返回 null。 */
interface Action {
  label: string
  run: (d: SquareDetail) => Promise<string | null>
}

/** 文字放入输入框后关闭弹窗：输入框在弹窗之下。 */
function toComposer(text: string): Promise<null> {
  askInChat(text)
  setSquareOpen(false)
  return Promise.resolve(null)
}

const install = (label: string): Action => ({
  label,
  run: async (d) => (await installSquareItem(d.id)).message,
})

/** 各类型的操作，按类型一个处理器；作品没有提示词时没有操作。 */
const ACTIONS: Record<SquareKind, (d: SquareDetail) => Action | null> = {
  work: (d) => {
    const prompt = (d.meta as SquareMetaByKind['work']).prompt
    return prompt ? { label: '使用提示词', run: () => toComposer(prompt) } : null
  },
  prompt: (d) => ({
    label: '使用',
    run: () => toComposer((d.meta as SquareMetaByKind['prompt']).text),
  }),
  canvas: () => ({
    label: '导入',
    run: async (d) => {
      const done = await installSquareItem(d.id)
      if (!done.canvas) return done.message
      openFileInPanel(done.canvas)
      setSquareOpen(false)
      return null
    },
  }),
  plugin: () => install('安装'),
  skill: () => install('安装'),
  mcp: () => install('添加'),
  pet: () => install('添加'),
  skin: () => install('应用'),
}

/** 条目详情：标题、发布者、版本、简介、内容预览与操作。 */
export function SquareItem(props: { id: string; onBack: () => void }) {
  const [detail] = createResource(() => props.id, squareDetail)
  const [busy, setBusy] = createSignal(false)
  const [result, setResult] = createSignal<{ ok: boolean; text: string } | null>(null)

  const act = async (action: Action, d: SquareDetail) => {
    setBusy(true)
    setResult(null)
    try {
      const text = await action.run(d)
      if (text) setResult({ ok: true, text })
    } catch (e) {
      setResult({ ok: false, text: explainApiError(e, `${action.label}失败`) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="square-item">
      <button type="button" class="btn-ghost sm square-back" onClick={() => props.onBack()}>
        <IconChevron size={14} dir="left" />
        返回
      </button>
      <Show when={detail.error}>
        {(e) => <p class="square-error">{explainApiError(e(), '读取失败')}</p>}
      </Show>
      <Show when={detail()}>
        {(d) => (
          <>
            <div class="square-item-head">
              <div>
                <h3 class="square-item-title">{d().title}</h3>
                <span class="square-item-sub">
                  {SQUARE_KIND_LABEL[d().kind]} · {d().author} · 版本 {d().version}
                  {d().license ? ` · ${d().license}` : ''}
                </span>
              </div>
              <Show when={ACTIONS[d().kind](d())}>
                {(action) => (
                  <button
                    type="button"
                    class="btn-primary"
                    disabled={busy()}
                    onClick={() => void act(action(), d())}
                  >
                    {action().label}
                  </button>
                )}
              </Show>
            </div>
            <Show when={result()}>
              {(r) => (
                <p classList={{ 'square-result': r().ok, 'square-error': !r().ok }}>{r().text}</p>
              )}
            </Show>
            <Show when={d().summary}>
              <p class="square-summary">{d().summary}</p>
            </Show>
            {PREVIEWS[d().kind](d())}
          </>
        )}
      </Show>
    </div>
  )
}
