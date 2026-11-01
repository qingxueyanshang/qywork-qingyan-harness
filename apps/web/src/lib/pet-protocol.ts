/**
 * 主窗口、桌面宠物窗口与任务框窗口之间的事件名与载荷。各方共用本文件。
 *
 * 必须保持叶子模块：只含常量与类型，类型以 `import type` 引入。宠物窗口导入本文件，
 * 若本文件在运行时导入 store，宠物窗口加载时即创建一份服务连接对象。
 */

import type { PetPack, PetState } from '@qywork/core'
import type { PetEntry, PetResult } from './store/appearance/pet.ts'

/** 推送给宠物窗口与任务框窗口的完整状态。每次整体替换，两个窗口都不保留增量。 */
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
  /** 个性化的强调色与其上的文字色（角标）。null 表示使用主题的强调色。 */
  accent: { color: string; fg: string } | null
}

/**
 * 任务框窗口回传的操作。打开会话经外壳命令 `pet_open_main` 先唤起主窗口，不在此列。
 * 关闭宠物只经设置页的开关，两个窗口都不回传关闭操作。
 */
export type PetWindowAction = { type: 'stop'; id: string }

/** 宠物在屏幕上的左下角（逻辑像素），即保存与恢复的位置。更换宠物包时窗口尺寸改变，左下角不变。 */
export interface PetAnchor {
  left: number
  bottom: number
}

export const PET_WINDOW_LABEL = 'pet'
/**
 * 任务框窗口：气泡与列表。与宠物窗口分开，宠物窗口的尺寸与位置因此不随展开与收起改变。
 * 在同一个窗口中展开时，窗口位置改变的那一帧 WebView 仍按左上角显示上一帧画面，宠物上下跳动一次。
 */
export const PET_BOX_LABEL = 'pet-box'
export const PET_STATE_EVENT = 'pet://state'
export const PET_READY_EVENT = 'pet://ready'
export const PET_ACTION_EVENT = 'pet://action'
/** 宠物窗口在单击宠物后发给任务框窗口，打开或关闭列表，无载荷。 */
export const PET_BOX_TOGGLE_EVENT = 'pet://box-toggle'
/** 外壳在 `pet_open_main` 唤起主窗口后发给主窗口，载荷为会话 id。 */
export const PET_OPEN_EVENT = 'pet://open'
/** 外壳在宠物窗口移动后发给宠物窗口，载荷为窗口左上角的逻辑坐标 `{ x, y }`。 */
export const PET_WINDOW_MOVED_EVENT = 'pet://window-moved'
/** 宠物窗口据窗口位置与尺寸算出宠物的左下角后发给主窗口保存，载荷为 `PetAnchor`。 */
export const PET_MOVED_EVENT = 'pet://moved'
