/**
 * 生成面板里选素材的弹出块：`@`、素材格的「+」、首尾帧空位共用。
 *
 * 一个搜索框同时筛画布上已有的节点与工作区文件；底部一行从本机上传。首尾帧模式下的 `@` 只能引用已连上的两帧，
 * 这时不提供文件与上传（`files` 为假）。选工作区文件或上传时由调用方先把文件放上画布，
 * 再按选中画布节点的同一条路径连线或插入引用。尺寸固定，结果在框内滚动。
 */

import { type CanvasFileKind, type CanvasNode, displayNameOf } from '@qywork/core'
import { createSignal, For, type JSX, Show } from 'solid-js'
import FileTypeIcon from '../FileTypeIcon.tsx'
import { IconUpload } from '../Icons.tsx'
import { createFileSearch } from './search.ts'

export function SourcePicker(props: {
  /** 可选的画布节点，已按用途过滤。 */
  nodes: CanvasNode[]
  /** 是否提供工作区文件与上传；为假时只筛画布节点。 */
  files: boolean
  /** 列哪几类工作区文件。 */
  kinds: readonly CanvasFileKind[]
  /** 在类别之上再筛一道：要的范围比类别窄时给。 */
  accepts?: (path: string) => boolean
  /** 上传框的 `accept`。 */
  accept: string
  thumb: (nodeId: string) => JSX.Element
  onNode: (id: string) => void
  onFile: (path: string) => void
  onUpload: (files: File[]) => void
}) {
  const [query, setQuery] = createSignal('')
  const files = createFileSearch(
    () => props.kinds,
    (path) => props.accepts?.(path) ?? true,
  )
  if (props.files) files.search('')
  let upload!: HTMLInputElement

  const nodes = () => {
    const q = query().trim().toLowerCase()
    return q ? props.nodes.filter((n) => displayNameOf(n).toLowerCase().includes(q)) : props.nodes
  }

  return (
    <>
      <input
        type="search"
        placeholder="搜索素材"
        spellcheck={false}
        ref={(el) => queueMicrotask(() => el.focus())}
        onInput={(e) => {
          setQuery(e.currentTarget.value)
          if (props.files) files.search(e.currentTarget.value)
        }}
      />
      <div class="canvas-pick-list">
        <For each={nodes()}>
          {(n) => (
            <button type="button" onClick={() => props.onNode(n.id)}>
              <span class="canvas-menu-thumb">{props.thumb(n.id)}</span>
              <span class="truncate">{displayNameOf(n)}</span>
            </button>
          )}
        </For>
        <Show when={props.files && files.error()}>
          {(m) => <div class="canvas-picker-error">{m()}</div>}
        </Show>
        <For each={props.files ? files.hits() : []}>
          {(path) => (
            <button type="button" title={path} onClick={() => props.onFile(path)}>
              <span class="canvas-pick-file">
                <FileTypeIcon name={path} />
              </span>
              <span class="truncate">{path}</span>
            </button>
          )}
        </For>
      </div>
      <Show when={props.files}>
        <button class="canvas-pick-upload" type="button" onClick={() => upload.click()}>
          <IconUpload size={16} stroke={1.8} />
          从设备上传
        </button>
        <input
          ref={upload}
          type="file"
          multiple
          hidden
          accept={props.accept}
          onChange={(e) => {
            const picked = [...(e.currentTarget.files ?? [])]
            if (picked.length) props.onUpload(picked)
            e.currentTarget.value = ''
          }}
        />
      </Show>
    </>
  )
}
