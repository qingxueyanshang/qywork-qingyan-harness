import { definePort } from '@qywork/agent'
import type { Personalization, PersonalizationEntry, PetEntry, PetPack } from '@qywork/core'

/**
 * 个性化端口。
 *
 * 读写与校验位于 runtime，变更广播位于 server；工具只声明动作，server 组合二者实现该端口并注入。
 * 只注入给有服务端的顶层会话：个性化作用于界面，CLI 会话没有界面，成员会话不代替用户修改界面。
 * 未注入时 `personalize` 不注册。
 */
export interface PersonalizationPort {
  /** 读取失败（文件内容损坏）时 `error` 原样交给大模型。 */
  read(): Promise<{ ok: true; entry: PersonalizationEntry } | { ok: false; error: string }>
  /** 整体保存。`image` 随同一次保存写入个性化目录。失败时 `error` 原样交给大模型。 */
  save(
    value: Personalization,
    image?: { name: string; bytes: Uint8Array },
  ): Promise<{ ok: true; entry: PersonalizationEntry } | { ok: false; error: string }>
  /** 恢复默认。 */
  reset(): Promise<PersonalizationEntry>
}

export const PersonalizationPort = definePort<PersonalizationPort>('personalization')

/**
 * 宠物库端口。理由与注入范围同 `PersonalizationPort`；当前屏幕选用哪只宠物由界面记录，
 * 选用由界面在当前会话收到工具的成功结果时执行。未注入时 `pet` 不注册。
 */
export interface PetPort {
  list(): Promise<PetEntry[]>
  read(id: string): Promise<PetEntry | null>
  /** `id` 为 null 时新建。`images` 随同一次保存写入宠物目录。失败时 `error` 原样交给大模型。 */
  save(
    id: string | null,
    pack: PetPack,
    images: { name: string; bytes: Uint8Array }[],
  ): Promise<{ ok: true; entry: PetEntry } | { ok: false; error: string }>
}

export const PetPort = definePort<PetPort>('pets')
