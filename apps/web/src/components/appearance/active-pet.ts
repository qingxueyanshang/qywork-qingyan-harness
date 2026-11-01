/**
 * 当前显示的宠物：选用的宠物包已读取时取它，否则取内置宠物。窗口内与桌面宠物共用。
 */

import type { PetPack } from '@qywork/core'
import { petFrameUrl, petPack } from '../../lib/store/index.ts'
import { DEFAULT_PET, defaultPetFrame } from './pet-default.ts'

export function activePet(): { pack: PetPack; frameUrl: (name: string) => string } {
  const entry = petPack()
  return entry
    ? { pack: entry.pack, frameUrl: (name) => petFrameUrl(entry, name) }
    : { pack: DEFAULT_PET, frameUrl: defaultPetFrame }
}
