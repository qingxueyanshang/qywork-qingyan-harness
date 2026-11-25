/**
 * 远程画面的缩放比例：档位换算与按页签的记录。
 *
 * 比例是该客户端的显示参数，经查看连接的 `size.zoom` 交给服务端，只在查看期间生效，不写入宿主的页签清单；
 * 整页刷新后恢复（`sessionSignal`）。
 */

import { BROWSER_VIEW_ZOOM_LEVELS } from '@qywork/core'
import type { Accessor, Setter } from 'solid-js'
import { sessionSignal } from '../../lib/session.ts'

export const ZOOM_MIN = BROWSER_VIEW_ZOOM_LEVELS[0] ?? 1
export const ZOOM_MAX = BROWSER_VIEW_ZOOM_LEVELS[BROWSER_VIEW_ZOOM_LEVELS.length - 1] ?? 1

/** 浮点误差内视为同一档。 */
const EPSILON = 1e-3

/** 当前比例的上一档或下一档；比例不在档位上时取其上方或下方最近的一档，已在端点时不变。 */
export function zoomStep(current: number, direction: 1 | -1): number {
  const next =
    direction > 0
      ? BROWSER_VIEW_ZOOM_LEVELS.find((z) => z > current + EPSILON)
      : [...BROWSER_VIEW_ZOOM_LEVELS].reverse().find((z) => z < current - EPSILON)
  return next ?? current
}

/** 与该比例最接近的一档。按比值比较：50% 与 100% 的分界是 71%，不是 75%。 */
export function nearestZoom(value: number): number {
  const distance = (z: number) => Math.abs(Math.log(z / value))
  let best = 1
  for (const z of BROWSER_VIEW_ZOOM_LEVELS) if (distance(z) < distance(best)) best = z
  return best
}

/** 该页签在本客户端的缩放比例，初值为 1。 */
export function viewZoom(tabId: string): [Accessor<number>, Setter<number>] {
  return sessionSignal(`qywork.browser.zoom:${tabId}`, 1)
}
