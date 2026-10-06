import type { JSX } from 'solid-js'
import { onMount } from 'solid-js'

/** 卡片与锚点之间的间距。 */
const GAP = 4
/** 靠近窗口边缘时保留的边距。 */
const EDGE = 8

/**
 * `below-end`：位于下方，右边缘与锚点右边缘对齐，下方空间不足时改为上方（侧栏「⋯」等行尾按钮）。
 * `above-start`：位于上方，左边缘与锚点左边缘对齐，上方空间不足时改为下方（输入框底栏的按钮，与会话输入框相同）。
 * `below-start`：位于下方，左边缘与锚点左边缘对齐，下方空间不足时改为上方（右键菜单：锚点是指针所在位置）。
 */
export type MenuPlacement = 'below-end' | 'above-start' | 'below-start'

type Rect = Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right'>

/** 卡片左上角的窗口坐标。两个方向空间均不足时仍取首选方向，再按窗口边缘向内收回。 */
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
  const left = placement === 'below-end' ? anchor.right - box.width : anchor.left
  return {
    top: Math.max(EDGE, top),
    left: Math.max(EDGE, Math.min(left, view.width - box.width - EDGE)),
  }
}

/**
 * 固定在某个按钮上的菜单卡片。只负责定位，展开与收起由调用方管理。
 *
 * **卡片必须是 `position: fixed`**（样式由调用方的完整规则提供，见 B8）：侧栏中的
 * 菜单位于 `overflow-y: auto` 的列表内，绝对定位会被容器边缘裁剪，靠近列表末尾的
 * 行只能显示第一项。fixed 脱离所有滚动容器，代价是坐标需要自行计算。
 *
 * 先测量再定位，不使用估算高度：项数随客户端与状态变化（桌面端多一项），写死的常量会与实际不一致。
 * `onMount` 在插入 DOM 之后、当前帧绘制之前执行，定位时不会闪烁。
 *
 * 边界：坐标只在挂载时计算一次。容器滚动或窗口尺寸改变后卡片会与锚点错位，
 * 调用方需在此时收起菜单。向上弹出的卡片高度在挂载后也不得变化，否则下边缘会离开锚点。
 */
export function AnchoredMenu(props: {
  /** 卡片自身完整样式规则的类名。 */
  class: string
  anchor: HTMLElement
  /** 默认为 `below-end`。 */
  placement?: MenuPlacement
  /** 按初次内容高度锁定外框，后续展开的内容在框内滚动。 */
  lockHeight?: boolean
  children: JSX.Element
}) {
  let el!: HTMLDivElement
  onMount(() => {
    const box = el.getBoundingClientRect()
    if (props.lockHeight) el.style.height = `${box.height}px`
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
