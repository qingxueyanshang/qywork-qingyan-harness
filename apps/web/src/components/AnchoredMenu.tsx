import type { JSX } from 'solid-js'
import { onMount } from 'solid-js'

/** 卡片与锚点之间的空。 */
const GAP = 4
/** 贴着窗口边时留的余量。 */
const EDGE = 8

/**
 * 钉在某个按钮上的菜单卡片。只负责摆位置，开合与收起由调用方管。
 *
 * **卡片必须是 `position: fixed`**（样式由调用方那条完整规则给，见 B8）：侧栏这些
 * 菜单挂在 `overflow-y: auto` 的列表里，绝对定位会被容器边沿裁掉，靠近列表末尾的
 * 行只露得出第一项。fixed 脱离所有滚动容器，代价是坐标要自己算。
 *
 * 量出来再摆，不用估的高度：项数随端和状态变（桌面端多一项），写死的常量对不上。
 * `onMount` 在插入 DOM 之后、这一帧绘制之前跑，摆位不会闪一下。
 *
 * 边界：坐标只在挂载时算一次。容器滚动或窗口改尺寸后卡片会与锚点脱节，
 * 调用方要在那时收起菜单。
 */
export function AnchoredMenu(props: {
  /** 卡片自己那条完整样式规则的类名。 */
  class: string
  anchor: HTMLElement
  children: JSX.Element
}) {
  let el!: HTMLDivElement
  onMount(() => {
    const a = props.anchor.getBoundingClientRect()
    const box = el.getBoundingClientRect()
    // 下面放不下就翻到上方；横向贴锚点右缘，越过窗口右沿再收回来。
    const below = a.bottom + GAP + box.height <= window.innerHeight - EDGE
    const top = below ? a.bottom + GAP : a.top - GAP - box.height
    const left = Math.min(a.right - box.width, window.innerWidth - box.width - EDGE)
    el.style.top = `${Math.max(EDGE, top)}px`
    el.style.left = `${Math.max(EDGE, left)}px`
  })

  return (
    <div class={props.class} role="menu" ref={el}>
      {props.children}
    </div>
  )
}
