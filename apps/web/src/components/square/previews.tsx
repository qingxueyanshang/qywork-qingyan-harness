/**
 * 条目详情中的内容预览，按类型一个处理器（新增类型时编译器要求在此补一项）。
 * 文件地址取自 `squareFileUrl`：只作 `<img>` 与 `<video>` 的 `src`。
 */

import type { SquareDetail, SquareFile, SquareKind, SquareMetaByKind } from '@qywork/core'
import { For, type JSX, Show } from 'solid-js'
import { squareFileUrl } from '../../lib/store/square.ts'
import { IconFile } from '../Icons.tsx'

/** 预览中的一个分区：名称与内容。 */
function Block(props: { title: string; children: JSX.Element }) {
  return (
    <section class="square-block">
      <h4 class="square-block-title">{props.title}</h4>
      {props.children}
    </section>
  )
}

function FileList(props: { files: readonly SquareFile[] }) {
  return (
    <Block title="文件">
      <ul class="square-files">
        <For each={props.files}>
          {(f) => (
            <li>
              <IconFile size={14} />
              <span>{f.path}</span>
            </li>
          )}
        </For>
      </ul>
    </Block>
  )
}

/** 演示文稿的页面按顺序纵向排列；宠物的帧图尺寸小，按网格排列。 */
function Images(props: { files: readonly SquareFile[]; frames?: true }) {
  return (
    <div class={props.frames ? 'square-frames' : 'square-pages'}>
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
      <Show when={meta().prompt}>
        {(p) => (
          <Block title="提示词">
            <pre class="square-text">{p()}</pre>
          </Block>
        )}
      </Show>
    </>
  )
}

export const PREVIEWS: Record<SquareKind, (d: SquareDetail) => JSX.Element> = {
  work: (d) => <WorkPreview detail={d} />,
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
    <Block title="配置">
      <pre class="square-text">
        {JSON.stringify((d.meta as SquareMetaByKind['mcp']).server, null, 2)}
      </pre>
    </Block>
  ),
  pet: (d) => <Images files={d.files.filter((f) => f.path !== 'pet.json')} frames />,
  skin: (d) => (
    <Show when={d.cover}>
      {(c) => <img class="square-media" src={squareFileUrl(c())} alt="" />}
    </Show>
  ),
}
