/**
 * 外观：皮肤库与宠物库的读写与图片。
 *
 * 两者都是本机级数据（`<configDir>/skins/`、`<configDir>/pets/`），与项目无关，接口忽略 `?ws=`。
 * 当前屏幕选用哪套皮肤、哪只宠物不在服务端记录，见界面的 `lib/store/theme.ts` 与 `appearance/pet.ts`。
 *
 * 每次保存与删除都经 `announceSkin` 广播 `skins.changed`：设置页与 `skin` 工具修改同一份皮肤库，
 * 正在使用该皮肤的其他屏幕据此重新读取。
 */

import { isSkinImageName } from '@qywork/core'
import {
  deletePet,
  deleteSkin,
  listPets,
  listSkins,
  petImagePath,
  readPet,
  readSkin,
  SKIN_IMAGE_MAX_BYTES,
  type SkinSaveResult,
  saveSkin,
  skinImagePath,
} from '@qywork/runtime'
import { announcePet, announceSkin } from '../appearance.ts'
import type { EventBus } from '../bus.ts'
import { type ApiHandler, json } from './types.ts'

function saved(bus: EventBus, r: SkinSaveResult, status = 200): Response {
  if (!r.ok) return json({ error: r.error }, r.status)
  announceSkin(bus, r.entry.id, false)
  return json(r.entry, status)
}

export const handleAppearanceApi: ApiHandler = async (url, req, d) => {
  const p = url.pathname

  if (p === '/api/skins') {
    if (req.method === 'POST') {
      const body = await req.json().catch(() => undefined)
      return saved(d.bus, await saveSkin(null, body), 201)
    }
    return json(await listSkins())
  }

  const one = /^\/api\/skins\/([^/]+)$/.exec(p)
  if (one) {
    const id = decodeURIComponent(one[1] as string)
    if (req.method === 'PUT') {
      const body = await req.json().catch(() => undefined)
      return saved(d.bus, await saveSkin(id, body))
    }
    if (req.method === 'DELETE') {
      if (!(await deleteSkin(id))) return json({ error: `皮肤不存在：${id}` }, 404)
      announceSkin(d.bus, id, true)
      return json({ ok: true })
    }
    const entry = await readSkin(id)
    return entry ? json(entry) : json({ error: `皮肤不存在：${id}` }, 404)
  }

  /*
   * 设置背景图片：写入图片并把背景改为该图片，一次完成。
   *
   * 不拆为「上传图片」与「修改背景」两个请求：皮肤库只保留当前引用的图片（见 `saveSkin`），
   * 单独上传的图片在下一次保存时即被删除。填充方式、暗化与模糊沿用原图片背景的值，
   * 原背景不是图片时取默认值。
   */
  const image = /^\/api\/skins\/([^/]+)\/image$/.exec(p)
  if (image && req.method === 'PUT') {
    const id = decodeURIComponent(image[1] as string)
    const name = url.searchParams.get('name') ?? ''
    if (!isSkinImageName(name)) return json({ error: `图片文件名不合法：${name}` }, 422)
    const entry = await readSkin(id)
    if (!entry) return json({ error: `皮肤不存在：${id}` }, 404)
    const bytes = new Uint8Array(await req.arrayBuffer())
    if (bytes.byteLength > SKIN_IMAGE_MAX_BYTES) {
      return json({ error: `图片超过 ${SKIN_IMAGE_MAX_BYTES / 1024 / 1024} MB` }, 422)
    }
    const bg = entry.skin.background
    const rest =
      bg.kind === 'image'
        ? { fit: bg.fit, dim: bg.dim, blur: bg.blur }
        : { fit: 'cover', dim: 0.2, blur: 0 }
    const skin = { ...entry.skin, background: { kind: 'image', file: name, ...rest } }
    return saved(d.bus, await saveSkin(id, skin, [{ name, bytes }]))
  }

  // 图片直链：`<img>` 与 CSS 背景无法携带 Authorization 头，令牌经查询串传入（`/api/` 统一校验）。
  const file = /^\/api\/skins\/([^/]+)\/files\/([^/]+)$/.exec(p)
  if (file) {
    const path = await skinImagePath(
      decodeURIComponent(file[1] as string),
      decodeURIComponent(file[2] as string),
    )
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
