/**
 * 外观的服务端装配：皮肤库与宠物库变更的广播，以及注入会话的 `SkinPort` / `PetPort`。
 *
 * HTTP 接口（`api/appearance.ts`）与 `skin` / `pet` 工具都经由此处广播：
 * 两条修改路径各自广播时，一处遗漏即使正在使用该皮肤或宠物的屏幕无法更新。
 */

import type { PetPort, SkinPort } from '@qywork/agent'
import { listPets, listSkins, readPet, readSkin, savePet, saveSkin } from '@qywork/runtime'
import type { EventBus } from './bus.ts'

/** 广播皮肤库变更。工作区级事件，不带 `conversationId`：所有客户端都需要收到。 */
export function announceSkin(bus: EventBus, id: string, removed: boolean): void {
  bus.publish({ type: 'skins.changed', id, removed })
}

export function skinPort(bus: EventBus): SkinPort {
  return {
    list: async () => (await listSkins()).skins,
    read: (id) => readSkin(id),
    save: async (id, skin, image) => {
      const r = await saveSkin(id, skin, image ? [image] : [])
      if (!r.ok) return { ok: false, error: r.error }
      announceSkin(bus, r.entry.id, false)
      return { ok: true, entry: r.entry }
    },
  }
}

/** 广播宠物库变更。理由同 `announceSkin`。 */
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
