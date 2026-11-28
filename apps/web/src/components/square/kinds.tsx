/**
 * 各类型在界面上的图标与列表版式，按类型一个条目（新增类型时编译器要求在此补一项）。
 * `gallery` 为封面网格，用于有封面的类型；`list` 为图标加简介的双列行，用于没有封面的类型。
 */

import type { SquareKind } from '@qywork/core'
import type { JSX } from 'solid-js'
import {
  IconCanvas,
  IconImage,
  IconPalette,
  IconPaw,
  IconPlug,
  IconSkillSolid,
  IconTerminal,
} from '../Icons.tsx'

export interface KindView {
  icon: (p: { size?: number; class?: string }) => JSX.Element
  /** 实心图标降低一级明度，与线框图标的视觉重量一致（同设置导航中的技能图标）。 */
  iconClass?: string
  layout: 'gallery' | 'list'
  /** 封面按原比例完整显示：宠物的帧图带透明边距，裁切后只剩局部。 */
  contain?: true
}

export const KIND_VIEW: Record<SquareKind, KindView> = {
  work: { icon: IconImage, layout: 'gallery' },
  canvas: { icon: IconCanvas, layout: 'gallery' },
  plugin: { icon: IconPlug, layout: 'list' },
  skill: { icon: IconSkillSolid, iconClass: 'settings-nav-skill-icon', layout: 'list' },
  mcp: { icon: IconTerminal, layout: 'list' },
  pet: { icon: IconPaw, layout: 'gallery', contain: true },
  skin: { icon: IconPalette, layout: 'gallery' },
}
