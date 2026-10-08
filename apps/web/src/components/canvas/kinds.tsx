/** 画布上各类节点的图标与生成类别的名称，工具条、菜单与节点标题共用。 */

import type { GenerateOutput } from '@qywork/core'
import { Match, Switch } from 'solid-js'
import { IconArt, IconAudio, IconFile, IconImage, IconTimeline, IconVideo } from '../Icons.tsx'

export const OUTPUT_LABEL: Record<GenerateOutput, string> = {
  image: '图像生成',
  video: '视频生成',
  audio: '音频生成',
  art: 'Art 生成',
}

export function KindIcon(props: {
  kind: GenerateOutput | 'text' | 'timeline' | null
  size?: number
  stroke?: number | undefined
}) {
  return (
    <Switch fallback={<IconFile size={props.size ?? 12} stroke={props.stroke} />}>
      <Match when={props.kind === 'image'}>
        <IconImage size={props.size ?? 12} stroke={props.stroke} />
      </Match>
      <Match when={props.kind === 'video'}>
        <IconVideo size={props.size ?? 12} stroke={props.stroke} />
      </Match>
      <Match when={props.kind === 'audio'}>
        <IconAudio size={props.size ?? 12} stroke={props.stroke} />
      </Match>
      <Match when={props.kind === 'art'}>
        <IconArt size={props.size ?? 12} stroke={props.stroke} />
      </Match>
      <Match when={props.kind === 'timeline'}>
        <IconTimeline size={props.size ?? 12} stroke={props.stroke} />
      </Match>
    </Switch>
  )
}
