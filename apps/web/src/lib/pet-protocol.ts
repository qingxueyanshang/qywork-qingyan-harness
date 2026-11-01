/**
 * 主窗口与桌面宠物窗口之间的事件名与载荷。两侧共用本文件。
 *
 * 必须保持叶子模块：只含常量与类型，类型以 `import type` 引入。宠物窗口导入本文件，
 * 若本文件在运行时导入 store，宠物窗口加载时即创建一份服务连接对象。
 */

import type { PetPack, PetState } from '@qywork/core'
import type { PetEntry, PetResult } from './store/appearance/pet.ts'

/** 推送给宠物窗口的完整状态。每次整体替换，宠物窗口不保留增量。 */
export interface PetWindowState {
  mood: PetState
  badge: string | null
  bubble: Pick<PetResult, 'conversationId' | 'title' | 'outcome'> | null
  entries: PetEntry[]
  pack: PetPack
  /** 帧文件名 → 图片地址。由主窗口生成：用户宠物包的地址带令牌，宠物窗口不持有令牌。 */
  frames: Record<string, string>
  /** 主窗口实际生效的明暗。宠物窗口的气泡与列表按它取色。 */
  dark: boolean
}

/** 宠物窗口回传的操作。打开会话经外壳命令 `pet_open_main` 先唤起主窗口，不在此列。 */
export type PetWindowAction = { type: 'stop'; id: string } | { type: 'hide' }

export const PET_WINDOW_LABEL = 'pet'
export const PET_STATE_EVENT = 'pet://state'
export const PET_READY_EVENT = 'pet://ready'
export const PET_ACTION_EVENT = 'pet://action'
/** 外壳在 `pet_open_main` 唤起主窗口后发给主窗口，载荷为会话 id。 */
export const PET_OPEN_EVENT = 'pet://open'
/** 外壳在宠物窗口移动后发给主窗口，载荷为逻辑坐标。 */
export const PET_MOVED_EVENT = 'pet://moved'
