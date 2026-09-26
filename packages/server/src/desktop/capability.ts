/**
 * 电脑控制此刻可用到什么程度。握手与 `desktop.state` 事件共用这一个判定。
 *
 * **三件事分开报。** 三者依次成立，合成一个布尔之后界面只说得出「用不了」，
 * 说不出卡在哪一步，而三步的下一步动作完全不同：装应用、等组件起来、授权。
 * 缺了哪几项前提（`missing`）原样转宿主报的那一份，服务端不按平台补判。
 *
 * 用户的启用开关不在这里：那是配置，由设置页按项读写。这一份只报客观状态。
 */

import type { DesktopCapability } from '@qywork/core'
import type { DesktopBridge } from './bridge.ts'

/** `bridge` 为 `null` 表示这个进程没有宿主凭据，电脑控制整条不存在。 */
export function desktopCapability(bridge: DesktopBridge | null): DesktopCapability {
  const host = bridge?.host() ?? null
  return {
    connected: host !== null,
    workerReady: host?.workerReady === true,
    authorized: host?.authorized === true,
    missing: host?.missing ?? [],
  }
}
