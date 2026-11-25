/**
 * 远程画面中由客户端代为显示的弹出层（协议见 `@qywork/core` 的 `BrowserViewPrompt`）：下拉框的选项、日期与颜色等输入框、
 * 网页的对话框、选择上传的文件。
 *
 * - 下拉框与输入框显示在网页中该控件的下方，下方空间不足时显示在上方；对话框与文件选择居中。
 * - 尺寸在打开时确定后不再变化（B9）：选项多时在框内滚动。
 * - 点击弹出层以外的区域等同取消；对话框必须以按钮结束。
 * - 选择文件需要用户在本页面中点击：系统的文件对话框只能由用户的点击打开，服务端的通知到达时点击已经结束。
 */

import type { BrowserViewInput, BrowserViewPrompt, BrowserViewRect } from '@qywork/core'
import { createSignal, For, onMount, Show } from 'solid-js'
import { client } from '../../lib/store/index.ts'

/** 下拉框一行的高度（CSS 像素），与 `.remote-select > button` 的高度一致。 */
const ROW = 36
/** 弹出层与画面边缘、与控件之间的间距。 */
const GAP = 8

export interface PromptArea {
  /** 显示区域的尺寸。 */
  width: number
  height: number
  /** 页面视口中的矩形换算为显示区域中的矩形。 */
  place: (rect: BrowserViewRect) => BrowserViewRect
}

/** 放在控件下方，下方空间不足时放在上方；宽度不小于控件，左右不超出显示区域。 */
function anchored(area: PromptArea, rect: BrowserViewRect, width: number, height: number) {
  const at = area.place(rect)
  const w = Math.min(Math.max(width, at.width), area.width - GAP * 2)
  const below = at.y + at.height + GAP
  const top = below + height <= area.height - GAP ? below : Math.max(GAP, at.y - GAP - height)
  const left = Math.min(Math.max(GAP, at.x), area.width - GAP - w)
  return { left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${height}px` }
}

export default function RemotePrompt(props: {
  prompt: BrowserViewPrompt
  tabId: string
  area: PromptArea
  send: (msg: BrowserViewInput) => void
  onDone: () => void
}) {
  const finish = (msg: BrowserViewInput) => {
    props.send(msg)
    props.onDone()
  }
  const cancel = () => {
    const p = props.prompt
    if (p.type === 'select' || p.type === 'input') finish({ type: 'answer', id: p.id, value: null })
    if (p.type === 'files') finish({ type: 'files', id: p.id, uploads: [] })
  }

  return (
    <div
      class="remote-prompt"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) cancel()
      }}
    >
      {(() => {
        const p = props.prompt
        switch (p.type) {
          case 'select':
            return <SelectBox prompt={p} area={props.area} finish={finish} />
          case 'input':
            return <InputBox prompt={p} area={props.area} finish={finish} cancel={cancel} />
          case 'dialog':
            return <DialogBox prompt={p} finish={finish} />
          case 'files':
            return <FilesBox prompt={p} tabId={props.tabId} finish={finish} cancel={cancel} />
        }
      })()}
    </div>
  )
}

function SelectBox(props: {
  prompt: Extract<BrowserViewPrompt, { type: 'select' }>
  area: PromptArea
  finish: (msg: BrowserViewInput) => void
}) {
  const p = props.prompt
  const rows = p.options.length + new Set(p.options.map((o) => o.group).filter(Boolean)).size
  const height = Math.min(rows * ROW + 8, Math.round(props.area.height * 0.6))
  let list!: HTMLDivElement
  onMount(() => {
    list.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'center' })
  })
  return (
    <div
      class="remote-select"
      role="listbox"
      ref={list}
      style={anchored(props.area, p.rect, 160, height)}
    >
      <For each={p.options}>
        {(o, i) => (
          <>
            <Show when={o.group && o.group !== p.options[i() - 1]?.group}>
              <div class="remote-select-group">{o.group}</div>
            </Show>
            <button
              type="button"
              role="option"
              aria-selected={o.value === p.value}
              disabled={o.disabled}
              onClick={() => props.finish({ type: 'answer', id: p.id, value: o.value })}
            >
              {o.label}
            </button>
          </>
        )}
      </For>
    </div>
  )
}

function InputBox(props: {
  prompt: Extract<BrowserViewPrompt, { type: 'input' }>
  area: PromptArea
  finish: (msg: BrowserViewInput) => void
  cancel: () => void
}) {
  const p = props.prompt
  let field!: HTMLInputElement
  onMount(() => {
    field.focus()
    // 打开系统的选择器；不在用户点击之内时浏览器拒绝，用户可再点击输入框打开。
    try {
      field.showPicker()
    } catch {}
  })
  return (
    <div class="remote-picker" style={anchored(props.area, p.rect, 240, 96)}>
      <input
        ref={field}
        type={p.kind}
        value={p.value}
        min={p.min || undefined}
        max={p.max || undefined}
        step={p.step || undefined}
      />
      <div class="remote-prompt-actions">
        <button class="btn-ghost sm" type="button" onClick={props.cancel}>
          取消
        </button>
        <button
          class="btn-primary sm"
          type="button"
          onClick={() => props.finish({ type: 'answer', id: p.id, value: field.value })}
        >
          确定
        </button>
      </div>
    </div>
  )
}

function DialogBox(props: {
  prompt: Extract<BrowserViewPrompt, { type: 'dialog' }>
  finish: (msg: BrowserViewInput) => void
}) {
  const p = props.prompt
  let field: HTMLInputElement | undefined
  const answer = (accept: boolean) =>
    props.finish({ type: 'dialog', accept, text: accept ? (field?.value ?? '') : '' })
  return (
    <div class="remote-dialog" role="alertdialog">
      <p>{p.message || (p.kind === 'beforeunload' ? '离开此页？' : '')}</p>
      <Show when={p.kind === 'prompt'}>
        <input ref={field} type="text" value={p.defaultPrompt} />
      </Show>
      <div class="remote-prompt-actions">
        <Show when={p.kind !== 'alert'}>
          <button class="btn-ghost sm" type="button" onClick={() => answer(false)}>
            取消
          </button>
        </Show>
        <button class="btn-primary sm" type="button" onClick={() => answer(true)}>
          确定
        </button>
      </div>
    </div>
  )
}

function FilesBox(props: {
  prompt: Extract<BrowserViewPrompt, { type: 'files' }>
  tabId: string
  finish: (msg: BrowserViewInput) => void
  cancel: () => void
}) {
  const p = props.prompt
  const [state, setState] = createSignal<'idle' | 'uploading' | 'failed'>('idle')
  const upload = async (files: File[]) => {
    if (files.length === 0) return
    setState('uploading')
    try {
      const uploads: string[] = []
      for (const file of files) uploads.push(await client.uploadBrowserFile(props.tabId, file))
      props.finish({ type: 'files', id: p.id, uploads })
    } catch {
      setState('failed')
    }
  }
  return (
    <div class="remote-files">
      <Show when={state() !== 'idle'}>
        <p>{state() === 'uploading' ? '上传中…' : '上传失败'}</p>
      </Show>
      <div class="remote-prompt-actions">
        <button class="btn-ghost sm" type="button" onClick={props.cancel}>
          取消
        </button>
        <label class="btn-primary sm" aria-disabled={state() === 'uploading'}>
          选择文件
          <input
            type="file"
            hidden
            multiple={p.multiple}
            accept={p.accept || undefined}
            disabled={state() === 'uploading'}
            onChange={(e) => void upload([...(e.currentTarget.files ?? [])])}
          />
        </label>
      </div>
    </div>
  )
}
