/**
 * 内置浏览器此刻可用到什么程度。握手与 `browser.state` 事件共用这一个判定。
 *
 * **两件事分开报。** 宿主连上即手动浏览可用；AI 控制还要运行时版本达标。
 * 合成一个布尔之后「运行时版本过低」会被读成「浏览器用不了」，
 * 界面会把手动浏览的入口也一起藏掉。宿主连着却没有可用浏览器时两项都为假，原因另报。
 */

import type { BrowserCapability } from '@qywork/core'
import type { BrowserBridge } from './bridge.ts'
import { meetsRuntimeFloor } from './coordinator.ts'

/** `bridge` 为 `null` 表示这个进程没有宿主凭据，浏览器控制整条不存在。 */
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
