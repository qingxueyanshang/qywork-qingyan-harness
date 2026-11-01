/**
 * 外观的服务端装配：个性化与宠物库变更的广播，以及注入会话的 `PersonalizationPort` / `PetPort`。
 *
 * HTTP 接口（`api/appearance.ts`）与 `personalize` / `pet` 工具都经由此处广播：
 * 两条修改路径各自广播时，一处遗漏即使其他屏幕无法更新。
 */

import type { PersonalizationPort, PetPort } from '@qywork/agent'
import {
  listPets,
  readPersonalization,
  readPet,
  resetPersonalization,
  savePersonalization,
  savePet,
} from '@qywork/runtime'
import type { EventBus } from './bus.ts'

/** 广播个性化变更。工作区级事件，不带 `conversationId`：所有客户端都需要收到。 */
export function announcePersonalization(bus: EventBus): void {
  bus.publish({ type: 'personalization.changed' })
}

export function personalizationPort(bus: EventBus): PersonalizationPort {
  return {
    read: () => readPersonalization(),
    save: async (value, image) => {
      const r = await savePersonalization(value, image ? [image] : [])
      if (r.ok) announcePersonalization(bus)
      return r
    },
    reset: async () => {
      const entry = await resetPersonalization()
      announcePersonalization(bus)
      return entry
    },
  }
}

/** 广播宠物库变更。理由同 `announcePersonalization`。 */
export function announcePet(bus: EventBus, id: string, removed: boolean): void {
  bus.publish({ type: 'pets.changed', id, removed })
}

export function petPort(bus: EventBus): PetPort {
  return {
    list: async () => (await listPets()).pets,
    read: (id) => readPet(id),
    save: async (id, pack, images) => {
      const r = await savePet(id, pack, images)
      if (!r.ok) return { ok: false, error: r.error }
      announcePet(bus, r.entry.id, false)
      return { ok: true, entry: r.entry }
    },
  }
}
