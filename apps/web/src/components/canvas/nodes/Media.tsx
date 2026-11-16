/** 节点中的媒体：图片、视频、Art 与音频；文本文件为文本预览，其余文件显示文件名。 */

import { canvasFileKind, type GenerateOutput } from '@qywork/core'
import { createMemo, createSignal, Match, onCleanup, Show, Switch } from 'solid-js'
import { IconFile } from '../../Icons.tsx'
import { ArtView } from '../ArtView.tsx'
import { Bitmap } from '../Bitmap.tsx'
import { useCanvas } from '../board/context.ts'
import { fileUrlOf } from '../GeneratePanel.tsx'
import { AudioPlayer, clock, VideoPlayer } from '../Player.tsx'
import { TextPreview } from './TextPreview.tsx'

/** `w` 是节点的画布宽度，图片按该宽度乘以当前缩放与设备像素比解码。 */
export function Media(p: {
  nodeId: string
  path: string
  kind: GenerateOutput | null
  w: number
  h: number
  controls: boolean
}) {
  const canvas = useCanvas()
  const [length, setLength] = createSignal<number | null>(null)
  // 经 memo 取值：重新读取画布而文件未变时地址不变，媒体不重新载入。
  const src = createMemo(() => fileUrlOf(canvas.view(), p.path))
  return (
    <Switch
      fallback={
        <Show
          when={canvasFileKind(p.path) === 'text'}
          fallback={
            <div class="canvas-media canvas-other">
              <IconFile size={20} />
              <span>{p.path.split('/').pop()}</span>
            </div>
          }
        >
          <TextPreview path={p.path} excerpt={canvas.excerptOfNode(p.nodeId)} />
        </Show>
      }
    >
      <Match when={p.kind === 'image'}>
        <div class="canvas-media">
          <Bitmap
            src={src()}
            width={p.w * canvas.z() * window.devicePixelRatio}
            height={p.h * canvas.z() * window.devicePixelRatio}
          />
        </div>
      </Match>
      <Match when={p.kind === 'video'}>
        <div class="canvas-media">
          {/* 选中时才挂载播放器：播放与取帧都需要它；未选中时只绘制封面。 */}
          <Show
            when={p.controls}
            fallback={
              <Bitmap
                kind="video"
                src={src()}
                width={p.w * canvas.z() * window.devicePixelRatio}
                height={p.h * canvas.z() * window.devicePixelRatio}
                onDuration={setLength}
              />
            }
          >
            <VideoPlayer
              src={src()}
              register={(player) => {
                canvas.players.set(p.nodeId, player)
                onCleanup(() => canvas.players.delete(p.nodeId))
              }}
              onDuration={setLength}
            />
          </Show>
          <Show when={!p.controls && length()}>
            {(s) => (
              <span class="canvas-badge" style={{ right: '6px', bottom: '6px' }}>
                {clock(s() * 1000)}
              </span>
            )}
          </Show>
        </div>
      </Match>
      <Match when={p.kind === 'art'}>
        <div class="canvas-media">
          {/* 只在单独选中时运行实时页面：同时运行的 WebGL 页面有数量上限，平移缩放时每个页面都要重绘。 */}
          <ArtView
            url={src()}
            w={p.w}
            h={p.h}
            z={canvas.z()}
            live={p.controls && canvas.selected().size === 1}
            register={(live) => {
              if (live) canvas.arts.set(p.nodeId, live)
              else canvas.arts.delete(p.nodeId)
            }}
          />
        </div>
      </Match>
      <Match when={p.kind === 'audio'}>
        <Show when={src()} keyed>
          {(url) => <AudioPlayer src={url} active={canvas.props.active} />}
        </Show>
      </Match>
    </Switch>
  )
}
