/**
 * 内置浏览器当前的可用程度。握手与 `browser.state` 事件共用该判定。
 *
 * 两项分别报告。宿主连接后即可手动浏览；AI 控制还要求运行时版本达标。
 * 合并为一个布尔值后，「运行时版本过低」会被理解为「浏览器不可用」，
 * 界面会把手动浏览的入口一并隐藏。宿主已连接但没有可用浏览器时两项均为假，原因单独报告。
 */

import type { BrowserCapability } from '@qywork/core'
import type { BrowserBridge } from './bridge.ts'
import { meetsRuntimeFloor } from './coordinator.ts'

/** `bridge` 为 `null` 表示该进程没有宿主凭据，不存在浏览器控制能力。 */
export function browserCapability(bridge: BrowserBridge | null): BrowserCapability {
  const host = bridge?.host() ?? null
  const unavailable = bridge?.unavailable() ?? null
  return {
    connected: host !== null,
    runtimeSupported: host !== null && meetsRuntimeFloor(host.runtimeVersion),
    ...(unavailable ? { unavailable } : {}),
    ...(host ? { presentation: host.presentation } : {}),
  }
}
