/**
 * 内置的默认宠物。帧是随应用发布的 PNG，位于 `public/pets/default/`，构建时原样复制到产物根目录，
 * 与用户宠物包走同一个渲染组件（`PetSprite`），只是取图方式不同：用户宠物包的帧来自宠物库接口。
 *
 * 帧地址写成以 `/` 开头的固定路径，不使用 Vite 的 `?url` 资源导入：测试运行时无法解析该后缀，
 * 组件测试会在导入时失败。页面部署在站点根路径，主窗口与宠物窗口同源，两处都能按该路径取图。
 */

import { PET_STATES, type PetAnimation, type PetPack, type PetState } from '@qywork/core'

/** 每个状态的图片张数。文件名为 `<状态>-01.png` 至 `<状态>-12.png`。 */
const FRAME_COUNT = 12

/** 12 张图片先正序后倒序播放，共 24 帧，首尾相接。 */
function animation(state: PetState): PetAnimation {
  const forward = Array.from(
    { length: FRAME_COUNT },
    (_, i) => `${state}-${String(i + 1).padStart(2, '0')}.png`,
  )
  return { frames: [...forward, ...forward.toReversed()], fps: 10 }
}

export const DEFAULT_PET: PetPack = {
  name: '大肥鱼娘 · 蓝色鲸鱼女仆',
  size: 144,
  states: Object.fromEntries(PET_STATES.map((s) => [s, animation(s)])) as Record<
    PetState,
    PetAnimation
  >,
}

/** 默认宠物某一帧的地址。 */
export function defaultPetFrame(name: string): string {
  return `/pets/default/${name}`
}
