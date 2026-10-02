/**
 * 画布左侧的工具条：新建生成卡与时间线、从工作区选文件、从本机上传。
 *
 * 平时只露图标，悬停或打开选择框时向右展开名字。展开只加宽度，图标位置不动，瞄准中的按钮不会移开。
 * 生成卡的类别全列：没配模型的类别也能建卡，卡上的模型按钮通往模型库。
 */

import { CANVAS_FILE_KINDS, type MediaOutput } from '@qywork/core'
import { createSignal, For, Show } from 'solid-js'
import FileTypeIcon from '../FileTypeIcon.tsx'
import { IconFolder, IconUpload } from '../Icons.tsx'
import { dismissOnOutside } from './dismiss.ts'
import { KindIcon, OUTPUT_LABEL } from './kinds.tsx'
import { createFileSearch } from './search.ts'

/** 工具条图标的尺寸与线宽：比正文里的图标大一号、线条更实。 */
const ICON = { size: 18, stroke: 1.9 }

/** `first` 表示这次打开选择框之后选的第一个。 */
type OnPick = (path: string, first: boolean) => void

export function Rail(props: {
  outputs: MediaOutput[]
  disabled: boolean
  onGenerate: (output: MediaOutput) => void
  onTimeline: () => void
  onPick: OnPick
  onUpload: (files: File[]) => void
}) {
  const [picking, setPicking] = createSignal<{ anchor: HTMLElement } | null>(null)
  let upload!: HTMLInputElement

  dismissOnOutside(picking, () => setPicking(null))

  return (
    <>
      <div class="canvas-rail" classList={{ expanded: !!picking() }}>
        <For each={props.outputs}>
          {(o) => (
            <button type="button" disabled={props.disabled} onClick={() => props.onGenerate(o)}>
              <KindIcon kind={o} {...ICON} />
              <span>{OUTPUT_LABEL[o]}</span>
            </button>
          )}
        </For>
        <button type="button" disabled={props.disabled} onClick={() => props.onTimeline()}>
          <KindIcon kind="timeline" {...ICON} />
          <span>时间线</span>
        </button>
        <hr />
        <button
          type="button"
          disabled={props.disabled}
          aria-expanded={!!picking()}
          onClick={(e) => {
            const anchor = e.currentTarget
            setPicking((v) => (v ? null : { anchor }))
          }}
        >
          <IconFolder {...ICON} />
          <span>从工作区选择</span>
        </button>
        <button type="button" disabled={props.disabled} onClick={() => upload.click()}>
          <IconUpload {...ICON} />
          <span>从设备上传</span>
        </button>
        <input
          ref={upload}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.currentTarget.files ?? [])]
            if (files.length) props.onUpload(files)
            // 清空后再选同一个文件也会触发 change。
            e.currentTarget.value = ''
          }}
        />
      </div>
      <Show when={picking()}>
        <Picker onPick={props.onPick} />
      </Show>
    </>
  )
}

/** 工作区文件的选择框：打开即列出能放上画布的文件，输入按名筛。选一个加一个，框不收起，可以连着选。 */
function Picker(props: { onPick: OnPick }) {
  const { hits, error, search } = createFileSearch(() => CANVAS_FILE_KINDS)
  search('')
  let picked = 0

  return (
    <div class="canvas-picker">
      <input
        type="search"
        placeholder="搜索工作区文件"
        spellcheck={false}
        ref={(el) => queueMicrotask(() => el.focus())}
        onInput={(e) => search(e.currentTarget.value)}
      />
      <div class="canvas-picker-list">
        <Show when={error()}>{(m) => <div class="canvas-picker-error">{m()}</div>}</Show>
        <For each={hits()}>
          {(path) => (
            <button type="button" title={path} onClick={() => props.onPick(path, picked++ === 0)}>
              <FileTypeIcon name={path} />
              <span class="truncate">{path}</span>
            </button>
          )}
        </For>
      </div>
    </div>
  )
}
