/**
 * 条目详情中的内容预览，按类型一个处理器（新增类型时编译器要求在此补一项）。
 * 文件地址取自 `squareFileUrl`：只作 `<img>` 与 `<video>` 的 `src`。
 */

import type { SquareDetail, SquareFile, SquareKind, SquareMetaByKind } from '@qywork/core'
import { For, type JSX, Show } from 'solid-js'
import { squareFileUrl } from '../../lib/store/square.ts'

function FileList(props: { files: readonly SquareFile[] }) {
  return (
    <ul class="square-files">
      <For each={props.files}>{(f) => <li>{f.path}</li>}</For>
    </ul>
  )
}

function Images(props: { files: readonly SquareFile[] }) {
  return (
    <div class="square-images">
      <For each={props.files}>{(f) => <img src={squareFileUrl(f.hash)} alt={f.path} />}</For>
    </div>
  )
}

const pageNumber = (path: string) => Number(/^pages\/(\d+)\.png$/.exec(path)?.[1] ?? 0)

function WorkPreview(props: { detail: SquareDetail }) {
  const meta = () => props.detail.meta as SquareMetaByKind['work']
  const media = () =>
    props.detail.files.find((f) => /^(image|video)\./.test(f.path) || f.path === 'deck.pptx')
  const cover = () => props.detail.cover
  const pages = () =>
    props.detail.files
      .filter((f) => f.path.startsWith('pages/'))
      .sort((a, b) => pageNumber(a.path) - pageNumber(b.path))
  return (
    <>
      <Show when={meta().format === 'image' && media()}>
        {(f) => <img class="square-media" src={squareFileUrl(f().hash)} alt="" />}
      </Show>
      <Show when={meta().format === 'video' && media()}>
        {(f) => (
          <video
            class="square-media"
            controls
            src={squareFileUrl(f().hash)}
            {...(cover() ? { poster: squareFileUrl(cover()!) } : {})}
          />
        )}
      </Show>
      <Show when={meta().format === 'pptx'}>
        <Images files={pages()} />
      </Show>
      <Show when={meta().prompt}>{(p) => <pre class="square-text">{p()}</pre>}</Show>
    </>
  )
}

export const PREVIEWS: Record<SquareKind, (d: SquareDetail) => JSX.Element> = {
  work: (d) => <WorkPreview detail={d} />,
  prompt: (d) => <pre class="square-text">{(d.meta as SquareMetaByKind['prompt']).text}</pre>,
  canvas: (d) => (
    <>
      <Show when={d.cover}>
        {(c) => <img class="square-media" src={squareFileUrl(c())} alt="" />}
      </Show>
      <FileList files={d.files.filter((f) => f.path !== 'canvas.json')} />
    </>
  ),
  plugin: (d) => <FileList files={d.files} />,
  skill: (d) => <FileList files={d.files} />,
  mcp: (d) => (
    <pre class="square-text">
      {JSON.stringify((d.meta as SquareMetaByKind['mcp']).server, null, 2)}
    </pre>
  ),
  pet: (d) => <Images files={d.files.filter((f) => f.path !== 'pet.json')} />,
  skin: (d) => (
    <Show when={d.cover}>
      {(c) => <img class="square-media" src={squareFileUrl(c())} alt="" />}
    </Show>
  ),
}
