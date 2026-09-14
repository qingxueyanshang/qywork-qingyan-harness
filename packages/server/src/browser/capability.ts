/**
 * 内置浏览器此刻可用到什么程度。握手与 `browser.state` 事件共用这一个判定。
 *
 * **三件事分开报。** 宿主连上即手动浏览可用；AI 控制还要运行时版本达标、
 * 而且装着声明 `browser:control` 的插件。合成一个布尔之后「插件没装」会被读成
 * 「浏览器用不了」，界面会把手动浏览的入口也一起藏掉。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserCapability } from '@qywork/core'
import { globalPluginsDir } from '@qywork/runtime'
import type { BrowserBridge } from './bridge.ts'
import { meetsRuntimeFloor } from './coordinator.ts'

/** 插件靠这条权限声明它要控制内置浏览器。按声明认，不按插件名猜。 */
const BROWSER_PERMISSION = 'browser:control'

/**
 * 全局插件目录里有没有装着浏览器控制插件。
 *
 * 同步读，而且不缓存：握手是每条连接一次、宿主变化是分钟级的事件，
 * 这点读盘可以忽略；缓存反而要多一条「装完插件怎么让它失效」的路径。
 */
function browserPluginInstalled(): boolean {
  let entries: string[]
  try {
    entries = readdirSync(globalPluginsDir())
  } catch {
    // 目录不存在 = 一个插件都没装。
    return false
  }
  for (const name of entries) {
    try {
      const raw = readFileSync(join(globalPluginsDir(), name, 'qywork.plugin.json'), 'utf8')
      const permissions = (JSON.parse(raw) as { permissions?: unknown }).permissions
      if (Array.isArray(permissions) && permissions.includes(BROWSER_PERMISSION)) return true
    } catch {
      // 读不出清单的目录不是插件；装不上的插件由插件页按 `loadExtensions` 的结果报。
    }
  }
  return false
}

/** `bridge` 为 `null` 表示这个进程没有宿主凭据，浏览器控制整条不存在。 */
export function browserCapability(bridge: BrowserBridge | null): BrowserCapability {
  const host = bridge?.host() ?? null
  return {
    connected: host !== null,
    runtimeSupported: host !== null && meetsRuntimeFloor(host.runtimeVersion),
    pluginInstalled: browserPluginInstalled(),
  }
}
