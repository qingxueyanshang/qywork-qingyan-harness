/**
 * 远程访问：配置 `remote` 为 true 且已登录云端账号时，运行远程监听器与隧道；任一条件不满足时两者都停止。
 *
 * 不变量：
 * - 开关只保存在配置中（经 `writeConfig` 写入）；隧道与监听器的启停只由 `sync` 按配置与登录状态决定。
 *   登录、退出与开关变化后都调用 `sync`。
 * - 停止时关闭远程监听器的全部连接，手机上已打开的页面立即断开。
 * - 隧道以「设备已被移除」关闭时，经 `onRevoked` 删除本地的云端接口，与网关返回 `device_revoked` 的处理相同。
 */

import type { QyConfig } from '@qywork/runtime'
import { writeConfig } from '../api/config.ts'
import { cloudProviderOf } from './account.ts'
import type { CloudOrigins } from './origins.ts'
import { TunnelClient, type TunnelClientOptions, type TunnelStatus } from './tunnel.ts'

/** 远程监听器：只绑定 127.0.0.1 的随机端口，`start` 返回端口，重复调用返回同一个。 */
export interface RemoteListener {
  start(): number
  stop(): void
}

export interface RemoteSnapshot {
  /** 已登录云端账号。为 false 时界面不显示远程访问。 */
  available: boolean
  enabled: boolean
  /** 隧道状态；未开启或未登录时为 null。 */
  tunnel: TunnelStatus | null
}

export interface RemoteAccessDeps {
  config: QyConfig
  origins: CloudOrigins | null
  listener: RemoteListener
  pairing: () => { token: string; deviceName: string }
  onRevoked: () => Promise<void>
  backoffMs?: TunnelClientOptions['backoffMs']
}

export class RemoteAccess {
  private tunnel: TunnelClient | null = null
  private key: string | null = null
  private status: TunnelStatus | null = null

  constructor(private readonly deps: RemoteAccessDeps) {}

  snapshot(): RemoteSnapshot {
    return {
      available: this.deviceKey() !== null,
      enabled: this.deps.config.remote === true,
      tunnel: this.status,
    }
  }

  /** 写入开关并按新值启停。配置校验失败时返回问题列表，不改变运行状态。 */
  async setEnabled(on: boolean): Promise<string[] | null> {
    const result = await writeConfig(this.deps.config, (current) => {
      const { remote: _remote, ...rest } = current
      return on ? { ...rest, remote: true } : rest
    })
    if (result instanceof Response) return [`配置写入失败（${result.status}）`]
    if ('problems' in result) return result.problems
    this.sync()
    return null
  }

  sync(): void {
    const key = this.deviceKey()
    const want = key !== null && this.deps.config.remote === true
    if (want && this.tunnel && this.key === key) return
    this.halt()
    if (!want || !this.deps.origins) return
    this.key = key
    this.status = { state: 'connecting' }
    const tunnel = new TunnelClient({
      apiOrigin: this.deps.origins.api,
      key,
      localPort: this.deps.listener.start(),
      pairing: this.deps.pairing,
      onStatus: (status) => {
        if (this.tunnel !== tunnel) return
        this.status = status
        if (status.state === 'revoked') void this.deps.onRevoked().then(() => this.sync())
      },
      ...(this.deps.backoffMs ? { backoffMs: this.deps.backoffMs } : {}),
    })
    this.tunnel = tunnel
    tunnel.start()
  }

  /** 上送一轮结束的通知；隧道未连接时不发送。 */
  notify(...args: Parameters<TunnelClient['notify']>): void {
    this.tunnel?.notify(...args)
  }

  stop(): void {
    this.halt()
  }

  private halt(): void {
    this.tunnel?.stop()
    this.tunnel = null
    this.key = null
    this.status = null
    this.deps.listener.stop()
  }

  private deviceKey(): string | null {
    if (!this.deps.origins) return null
    return cloudProviderOf(this.deps.config, this.deps.origins)?.apiKey ?? null
  }
}
