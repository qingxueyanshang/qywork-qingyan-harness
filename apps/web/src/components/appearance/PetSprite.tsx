/**
 * 按宠物包与状态播放帧动画。窗口内的宠物与桌面宠物窗口共用本组件。
 *
 * 只有一帧的状态加一组基础动作（呼吸、跳动、摇摆），由 CSS 只对 `transform` 做动画；
 * 多帧的状态由宠物包自己的帧表现动作，不再叠加。窗口不可见时停止换帧。
 */

import type { PetPack, PetState } from '@qywork/core'
import { createEffect, createSignal, onCleanup } from 'solid-js'

export function PetSprite(props: {
  pack: PetPack
  state: PetState
  /** 帧文件名 → 图片地址。 */
  frameUrl: (name: string) => string
}) {
  const [index, setIndex] = createSignal(0)
  const [visible, setVisible] = createSignal(!document.hidden)
  const sync = () => setVisible(!document.hidden)
  document.addEventListener('visibilitychange', sync)
  onCleanup(() => document.removeEventListener('visibilitychange', sync))

  const anim = () => props.pack.states[props.state]

  createEffect(() => {
    const a = anim()
    setIndex(0)
    if (a.frames.length < 2 || !visible()) return
    const timer = setInterval(() => setIndex((i) => (i + 1) % a.frames.length), 1000 / a.fps)
    onCleanup(() => clearInterval(timer))
  })

  const src = () => {
    const frames = anim().frames
    return props.frameUrl(frames[index() % frames.length] ?? frames[0] ?? '')
  }

  return (
    <img
      class="pet-sprite"
      classList={{ [`pet-motion-${props.state}`]: anim().frames.length === 1, paused: !visible() }}
      src={src()}
      width={props.pack.size}
      height={props.pack.size}
      alt=""
      draggable={false}
    />
  )
}
