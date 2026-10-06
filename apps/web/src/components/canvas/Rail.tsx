/**
 * 画布左侧的工具条：新建生成卡与时间线、从工作区选择文件、从本机上传。
 *
 * 默认只显示图标，悬停或打开选择框时向右展开名称。展开只增加宽度，图标位置不变，指针下的按钮不会移位。
 * 列出全部生成类别：未配置模型的类别也能创建卡片，卡片上的模型按钮打开模型库。
 */

import { CANVAS_FILE_KINDS, type MediaOutput } from '@qywork/core'
import { createSignal, For, Show } from 'solid-js'
import FileTypeIcon from '../FileTypeIcon.tsx'
import { IconFolder, IconUpload } from '../Icons.tsx'
import { dismissOnOutside } from './dismiss.ts'
import { KindIcon, OUTPUT_LABEL } from './kinds.tsx'
import { createFileSearch } from './search.ts'

/** 工具条图标的尺寸与线宽：比正文中的图标大一号，线条更粗。 */
const ICON = { size: 18, stroke: 1.9 }

/** `first` 表示本次打开选择框后选择的第一个文件。 */
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

/** 工作区文件的选择框：打开即列出可添加到画布的文件，输入时按名称筛选。每选择一个即添加一个，选择框不收起，可连续选择。 */
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
            <button
              type="button"
              data-tip={path}
              onClick={() => props.onPick(path, picked++ === 0)}
            >
              <FileTypeIcon name={path} />
              <span class="truncate">{path}</span>
            </button>
          )}
        </For>
      </div>
    </div>
  )
}
