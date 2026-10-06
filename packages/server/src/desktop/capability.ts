/**
 * 电脑控制当前的可用程度。握手与 `desktop.state` 事件共用该判定。
 *
 * **三项状态分别报告。** 三者依次成立，合并为一个布尔值后界面只能显示「不可用」，
 * 无法说明停滞于哪一步，而三步对应的后续操作完全不同：安装应用、等待组件启动、授权。
 * 缺少的前提（`missing`）原样转发宿主报告的内容，服务端不按平台另行判定。
 *
 * 用户的启用开关不在此处：它属于配置，由设置页按项读写。此处只报告客观状态。
 */

import type { DesktopCapability } from '@qywork/core'
import type { DesktopBridge } from './bridge.ts'

/** `bridge` 为 `null` 表示该进程没有宿主凭据，电脑控制能力不存在。 */
export function desktopCapability(bridge: DesktopBridge | null): DesktopCapability {
  const host = bridge?.host() ?? null
  return {
    connected: host !== null,
    workerReady: host?.workerReady === true,
    authorized: host?.authorized === true,
    missing: host?.missing ?? [],
  }
}
