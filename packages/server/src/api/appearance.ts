/**
 * 外观：个性化与宠物库的读写与图片。
 *
 * 两者都是本机级数据（`<configDir>/personalization/`、`<configDir>/pets/`），与项目无关，接口忽略 `?ws=`。
 * 当前屏幕的主题与选用哪只宠物不在服务端记录，见界面的 `lib/store/theme.ts` 与 `appearance/pet.ts`。
 *
 * 每次保存与恢复默认都经 `announcePersonalization` 广播 `personalization.changed`：设置页与
 * `personalize` 工具修改同一份个性化，其他屏幕据此重新读取。
 */

import { isPersonalImageName, revealBackdrop } from '@qywork/core'
import {
  deletePet,
  listPets,
  PERSONAL_IMAGE_MAX_BYTES,
  type PersonalizationSaveResult,
  personalImagePath,
  petImagePath,
  readPersonalization,
  readPet,
  resetPersonalization,
  savePersonalization,
} from '@qywork/runtime'
import { announcePersonalization, announcePet } from '../appearance.ts'
import type { EventBus } from '../bus.ts'
import { type ApiHandler, json } from './types.ts'

function saved(bus: EventBus, r: PersonalizationSaveResult): Response {
  if (!r.ok) return json({ error: r.error }, 422)
  announcePersonalization(bus)
  return json(r.entry)
}

export const handleAppearanceApi: ApiHandler = async (url, req, d) => {
  const p = url.pathname

  if (p === '/api/personalization') {
    if (req.method === 'PUT') {
      const body = await req.json().catch(() => undefined)
      return saved(d.bus, await savePersonalization(body))
    }
    if (req.method === 'DELETE') {
      const entry = await resetPersonalization()
      announcePersonalization(d.bus)
      return json(entry)
    }
    const r = await readPersonalization()
    return r.ok ? json(r.entry) : json({ error: r.error }, 422)
  }

  /*
   * 设置背景图片：写入图片并把背景改为该图片，一次完成。
   *
   * 不拆为「上传图片」与「修改背景」两个请求：目录中只保留当前引用的图片（见 `savePersonalization`），
   * 单独上传的图片在下一次保存时即被删除。填充方式、遮罩与模糊沿用原图片背景的值，原背景不是图片时取默认值。
   * 原先看不到背景时，不透明度在同一次保存中按 `revealBackdrop` 调整。
   */
  if (p === '/api/personalization/image' && req.method === 'PUT') {
    const name = url.searchParams.get('name') ?? ''
    if (!isPersonalImageName(name)) return json({ error: `图片文件名不合法：${name}` }, 422)
    const current = await readPersonalization()
    if (!current.ok) return json({ error: current.error }, 422)
    const bytes = new Uint8Array(await req.arrayBuffer())
    if (bytes.byteLength > PERSONAL_IMAGE_MAX_BYTES) {
      return json({ error: `图片超过 ${PERSONAL_IMAGE_MAX_BYTES / 1024 / 1024} MB` }, 422)
    }
    const value = current.entry.personalization
    const bg = value.background
    const rest =
      bg.kind === 'image'
        ? { fit: bg.fit, dim: bg.dim, blur: bg.blur }
        : { fit: 'cover' as const, dim: 0.2, blur: 0 }
    const next = revealBackdrop(value, {
      ...value,
      background: { kind: 'image', file: name, ...rest },
    })
    return saved(d.bus, await savePersonalization(next, [{ name, bytes }]))
  }

  // 图片直链：`<img>` 与 CSS 背景无法携带 Authorization 头，令牌经查询串传入（`/api/` 统一校验）。
  const file = /^\/api\/personalization\/files\/([^/]+)$/.exec(p)
  if (file) {
    const path = await personalImagePath(decodeURIComponent(file[1] as string))
    if (!path) return json({ error: '图片不存在' }, 404)
    return new Response(Bun.file(path), { headers: { 'cache-control': 'no-cache' } })
  }

  /*
   * 宠物库。帧图片随宠物包一起由 `pet` 工具写入；界面只读取、选用与删除，
   * 设置页不提供逐帧编辑，因此没有写接口。
   */
  if (p === '/api/pets') return json(await listPets())
  const pet = /^\/api\/pets\/([^/]+)$/.exec(p)
  if (pet) {
    const id = decodeURIComponent(pet[1] as string)
    if (req.method === 'DELETE') {
      if (!(await deletePet(id))) return json({ error: `宠物不存在：${id}` }, 404)
      announcePet(d.bus, id, true)
      return json({ ok: true })
    }
    const entry = await readPet(id)
    return entry ? json(entry) : json({ error: `宠物不存在：${id}` }, 404)
  }
  const petFile = /^\/api\/pets\/([^/]+)\/files\/([^/]+)$/.exec(p)
  if (petFile) {
    const path = await petImagePath(
      decodeURIComponent(petFile[1] as string),
      decodeURIComponent(petFile[2] as string),
    )
    if (!path) return json({ error: '图片不存在' }, 404)
    return new Response(Bun.file(path), { headers: { 'cache-control': 'no-cache' } })
  }

  return null
}
