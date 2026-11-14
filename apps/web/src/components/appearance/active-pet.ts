/**
 * 当前显示的宠物：选用「团子」时取它，选用的用户宠物包已读取时取该宠物包，否则取默认的内置宠物。
 * 窗口内与桌面宠物共用。
 */

import { DANGO_PET_ID, type PetPack } from '@qywork/core'
import { petFrameUrl, petPack, petPrefs } from '../../lib/store/index.ts'
import { DANGO_PET, dangoPetFrame } from './pet-dango.ts'
import { DEFAULT_PET, defaultPetFrame } from './pet-default.ts'

export function activePet(): { pack: PetPack; frameUrl: (name: string) => string } {
  if (petPrefs().pack === DANGO_PET_ID) return { pack: DANGO_PET, frameUrl: dangoPetFrame }
  const entry = petPack()
  return entry
    ? { pack: entry.pack, frameUrl: (name) => petFrameUrl(entry, name) }
    : { pack: DEFAULT_PET, frameUrl: defaultPetFrame }
}
