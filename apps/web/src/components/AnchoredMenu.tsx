import type { JSX } from 'solid-js'
import { onMount } from 'solid-js'

/** 卡片与锚点之间的空。 */
const GAP = 4
/** 贴着窗口边时留的余量。 */
const EDGE = 8

/**
 * `below-end`：下方、右缘贴锚点右缘，下方放不下翻到上方（侧栏「⋯」这类行尾按钮）。
 * `above-start`：上方、左缘贴锚点左缘，上方放不下翻到下方（输入框底栏的按钮，同会话输入框）。
 */
export type MenuPlacement = 'below-end' | 'above-start'

type Rect = Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right'>

/** 卡片左上角的窗口坐标。两个方向都放不下时仍取首选方向，再按窗口边收回。 */
export function placeMenu(
  anchor: Rect,
  box: { width: number; height: number },
  view: { width: number; height: number },
  placement: MenuPlacement,
): { top: number; left: number } {
  const below = anchor.bottom + GAP
  const above = anchor.top - GAP - box.height
  const fitsBelow = below + box.height <= view.height - EDGE
  const top =
    placement === 'above-start'
      ? above >= EDGE || !fitsBelow
        ? above
        : below
      : fitsBelow
        ? below
        : above
  const left = placement === 'above-start' ? anchor.left : anchor.right - box.width
  return {
    top: Math.max(EDGE, top),
    left: Math.max(EDGE, Math.min(left, view.width - box.width - EDGE)),
  }
}

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
 * 调用方要在那时收起菜单。向上弹出的卡片高度也必须在挂载后不再变，否则下沿离开锚点。
 */
export function AnchoredMenu(props: {
  /** 卡片自己那条完整样式规则的类名。 */
  class: string
  anchor: HTMLElement
  /** 缺省 `below-end`。 */
  placement?: MenuPlacement
  children: JSX.Element
}) {
  let el!: HTMLDivElement
  onMount(() => {
    const box = el.getBoundingClientRect()
    const at = placeMenu(
      props.anchor.getBoundingClientRect(),
      box,
      { width: window.innerWidth, height: window.innerHeight },
      props.placement ?? 'below-end',
    )
    el.style.top = `${at.top}px`
    el.style.left = `${at.left}px`
  })

  return (
    <div class={props.class} role="menu" ref={el}>
      {props.children}
    </div>
  )
}
