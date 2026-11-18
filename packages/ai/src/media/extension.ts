/**
 * 内置协议之外的生成协议与渠道规格的登记表。使用方在启动时登记（`registerMediaProtocol`、`registerMediaChannel`），
 * 规格解析（`resolveMediaModel`）、计量参数（`meterParamsFor`）与适配器构造（`buildMediaAdapter`）经此表取得登记的实现，
 * 不在各处另写协议名或渠道名的判断。电脑端不登记任何项。
 */

import {
  type ChannelSpec,
  type ExtensionMediaKind,
  type MediaKind,
  type MediaMeterParams,
  type MediaOutput,
  registerMediaKind,
  type StoredMediaSpec,
} from '@qywork/core'
import type { MediaModelSpec } from './catalog.ts'
import type { MediaAdapter, MediaProfile } from './types.ts'

/** 按连接参数与解析后的规格构造适配器。 */
export type MediaAdapterFactory = (profile: MediaProfile, spec: MediaModelSpec) => MediaAdapter

export interface MediaProtocol {
  kind: string
  output: MediaOutput
  /** 以该协议为该类别默认协议的接口地址主机名（`defaultMediaKind`）。 */
  hosts?: readonly string[]
  /** 目录未收录的型号使用的规格：只包含协议文档中的通用字段。 */
  defaults: Omit<MediaModelSpec, 'id' | 'displayName' | 'kind'>
  /** 张数、时长与分辨率档位的参数名，含义同 `meterParamsFor`。 */
  meter: MediaMeterParams
  adapter: MediaAdapterFactory
}

export interface MediaChannel {
  /** 保存规格中的 `channel`。 */
  id: string
  /**
   * 保存的规格在该协议上的生成规格。该协议不使用此规格时返回 undefined，规格按目录与协议默认解析。
   * `saved` 的其余字段由本渠道定义，调用方不校验。
   */
  spec(id: string, kind: MediaKind, saved: ChannelSpec): MediaModelSpec | undefined
  /** 本渠道型号的适配器；省略时按协议构造。 */
  adapter?: MediaAdapterFactory
}

const PROTOCOLS = new Map<string, MediaProtocol>()
const CHANNELS = new Map<string, MediaChannel>()

/** 登记生成协议，返回可用作 `MediaKind` 的协议名。协议名已存在时抛出（`registerMediaKind`）。 */
export function registerMediaProtocol(protocol: MediaProtocol): ExtensionMediaKind {
  const kind = registerMediaKind(protocol.kind, protocol.output, protocol.hosts)
  PROTOCOLS.set(kind, protocol)
  return kind
}

/** 登记渠道规格的解析与适配器。渠道已登记时抛出：两次登记的解析可能不同。 */
export function registerMediaChannel(channel: MediaChannel): void {
  if (CHANNELS.has(channel.id)) throw new Error(`渠道 ${channel.id} 已登记`)
  CHANNELS.set(channel.id, channel)
}

/** 登记的协议；内置协议返回 undefined。 */
export const mediaProtocolOf = (kind: MediaKind): MediaProtocol | undefined => PROTOCOLS.get(kind)

/** 保存的规格所属的已登记渠道；不是渠道规格或渠道未登记时返回 undefined。 */
export function mediaChannelOf(saved: StoredMediaSpec | undefined): MediaChannel | undefined {
  return saved && 'channel' in saved ? CHANNELS.get(saved.channel) : undefined
}
