/**
 * 皮肤的格式、校验与合并。皮肤库接口、`skin` 工具与界面共用同一份规则。
 *
 * 不变量：
 * - 皮肤只作用于界面骨架（外框、会话区、面板视图）。画布、终端、内置浏览器等内容区只跟随 `base`。
 * - 校验严格拒绝：未知字段、越界数值、非法颜色一律返回错误，不做修正。修正后写入磁盘的值
 *   与调用方给出的值不一致，模型与用户都无法据此判断哪一项未生效。
 * - 图片只记录文件名，文件位于该皮肤自己的目录中；不接受路径，路径解析只在落盘一侧进行。
 */

export type SkinBase = 'light' | 'dark'

export type SkinImageFit = 'cover' | 'contain' | 'tile'

export type SkinBackground =
  | { kind: 'color'; color: string }
  | { kind: 'gradient'; angle: number; stops: string[] }
  | { kind: 'image'; file: string; fit: SkinImageFit; dim: number; blur: number }

export type SkinEffect =
  | { kind: 'none' }
  | { kind: 'fog'; color: string; density: number; speed: number }

/**
 * 骨架底色。
 *
 * 不设毛玻璃半径：整个窗口都被骨架覆盖，透过骨架看到的只有背景层，模糊背景层本身
 * （图片背景的 `blur`）与对骨架做 `backdrop-filter` 结果相同，且后者使骨架成为
 * `position: fixed` 菜单的定位基准。
 */
export interface SkinSurface {
  /** 骨架底色的不透明度。1 表示与无皮肤时相同的不透明底色。 */
  opacity: number
}

export interface Skin {
  name: string
  base: SkinBase
  background: SkinBackground
  effect: SkinEffect
  surface: SkinSurface
  /** 强调色。`null` 表示沿用 `base` 对应的强调色。 */
  accent: string | null
}

/** 皮肤库中的一项。`id` 即目录名。 */
export interface SkinEntry {
  id: string
  skin: Skin
  updatedAt: number
}

/** 图片背景允许的扩展名（小写、含点）。 */
export const SKIN_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif'] as const

/** 各数值字段的取值范围，界面控件与校验使用同一份。 */
export const SKIN_LIMITS = {
  angle: [0, 360],
  stops: [2, 5],
  dim: [0, 0.9],
  imageBlur: [0, 40],
  density: [0, 1],
  speed: [0, 1],
  opacity: [0.2, 1],
  name: 40,
} as const

/** 新建皮肤时的初始值：与无皮肤时的深色外观相同。 */
export const DEFAULT_SKIN: Skin = {
  name: '新皮肤',
  base: 'dark',
  background: { kind: 'color', color: '#0c0c0d' },
  effect: { kind: 'none' },
  surface: { opacity: 1 },
  accent: null,
}

const COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/** 皮肤 id：目录名，只允许小写字母、数字、横线与下划线。 */
export function isSkinId(id: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)
}

/** 图片文件名：单段、无路径分隔符、扩展名在允许列表中。 */
export function isSkinImageName(name: string): boolean {
  if (!name || name.length > 128 || /[/\\]/.test(name) || name.includes('..')) return false
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return false
  return (SKIN_IMAGE_EXTENSIONS as readonly string[]).includes(name.slice(dot).toLowerCase())
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

class SkinError extends Error {}

function fail(message: string): never {
  throw new SkinError(message)
}

function record(raw: unknown, path: string, allowed: readonly string[]): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail(`${path} 必须是对象`)
  const obj = raw as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(`${path} 中有无法识别的字段：${key}`)
  }
  return obj
}

function color(raw: unknown, path: string): string {
  if (typeof raw !== 'string' || !COLOR_RE.test(raw)) {
    fail(`${path} 必须是 #rgb、#rrggbb 或 #rrggbbaa 格式的颜色`)
  }
  return raw.toLowerCase()
}

function num(raw: unknown, path: string, [min, max]: readonly [number, number]): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < min || raw > max) {
    fail(`${path} 必须是 ${min} 到 ${max} 之间的数值`)
  }
  return raw
}

function background(raw: unknown): SkinBackground {
  const kind = (raw as { kind?: unknown } | null)?.kind
  if (kind === 'color') {
    const o = record(raw, 'background', ['kind', 'color'])
    return { kind, color: color(o.color, 'background.color') }
  }
  if (kind === 'gradient') {
    const o = record(raw, 'background', ['kind', 'angle', 'stops'])
    const [lo, hi] = SKIN_LIMITS.stops
    if (!Array.isArray(o.stops) || o.stops.length < lo || o.stops.length > hi) {
      fail(`background.stops 必须是 ${lo} 到 ${hi} 个颜色`)
    }
    return {
      kind,
      angle: num(o.angle, 'background.angle', SKIN_LIMITS.angle),
      stops: o.stops.map((s, i) => color(s, `background.stops[${i}]`)),
    }
  }
  if (kind === 'image') {
    const o = record(raw, 'background', ['kind', 'file', 'fit', 'dim', 'blur'])
    if (typeof o.file !== 'string' || !isSkinImageName(o.file)) {
      fail(`background.file 必须是图片文件名（${SKIN_IMAGE_EXTENSIONS.join('、')}），不含路径`)
    }
    if (o.fit !== 'cover' && o.fit !== 'contain' && o.fit !== 'tile') {
      fail('background.fit 必须是 cover、contain 或 tile')
    }
    return {
      kind,
      file: o.file,
      fit: o.fit,
      dim: num(o.dim, 'background.dim', SKIN_LIMITS.dim),
      blur: num(o.blur, 'background.blur', SKIN_LIMITS.imageBlur),
    }
  }
  return fail('background.kind 必须是 color、gradient 或 image')
}

function effect(raw: unknown): SkinEffect {
  const kind = (raw as { kind?: unknown } | null)?.kind
  if (kind === 'none') {
    record(raw, 'effect', ['kind'])
    return { kind }
  }
  if (kind === 'fog') {
    const o = record(raw, 'effect', ['kind', 'color', 'density', 'speed'])
    return {
      kind,
      color: color(o.color, 'effect.color'),
      density: num(o.density, 'effect.density', SKIN_LIMITS.density),
      speed: num(o.speed, 'effect.speed', SKIN_LIMITS.speed),
    }
  }
  return fail('effect.kind 必须是 none 或 fog')
}

function skinOf(raw: unknown): Skin {
  const o = record(raw, '皮肤', ['name', 'base', 'background', 'effect', 'surface', 'accent'])
  const name = typeof o.name === 'string' ? o.name.trim() : ''
  if (!name || name.length > SKIN_LIMITS.name) fail(`name 必须是 1 到 ${SKIN_LIMITS.name} 个字符`)
  if (o.base !== 'light' && o.base !== 'dark') fail('base 必须是 light 或 dark')
  const s = record(o.surface, 'surface', ['opacity'])
  return {
    name,
    base: o.base,
    background: background(o.background),
    effect: effect(o.effect),
    surface: { opacity: num(s.opacity, 'surface.opacity', SKIN_LIMITS.opacity) },
    accent: o.accent === null ? null : color(o.accent, 'accent'),
  }
}

/** 校验一份完整的皮肤。 */
export function parseSkin(raw: unknown): Parsed<Skin> {
  try {
    return { ok: true, value: skinOf(raw) }
  } catch (e) {
    if (e instanceof SkinError) return { ok: false, error: e.message }
    throw e
  }
}

/**
 * 把部分修改合并到已有皮肤上，再整体校验。
 *
 * 参数组按 `kind` 合并：`kind` 相同时逐字段覆盖，不同时整组替换。不要改为深合并：
 * 从图片背景切换为纯色时，深合并会保留 `file` 等字段，结果因含无法识别的字段而被拒绝。
 */
export function mergeSkin(base: Skin, patch: unknown): Parsed<Skin> {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return { ok: false, error: '修改内容必须是对象' }
  }
  const p = patch as Record<string, unknown>
  const group = (current: object, next: unknown): unknown => {
    if (next === undefined) return current
    if (typeof next !== 'object' || next === null || Array.isArray(next)) return next
    const cur = current as { kind?: unknown }
    const nxt = next as { kind?: unknown }
    if (nxt.kind !== undefined && nxt.kind !== cur.kind) return next
    return { ...current, ...next }
  }
  return parseSkin({
    ...base,
    ...p,
    background: group(base.background, p.background),
    effect: group(base.effect, p.effect),
    surface: group(base.surface, p.surface),
  })
}
