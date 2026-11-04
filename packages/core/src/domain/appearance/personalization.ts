/**
 * 个性化的格式、校验与合并。个性化接口、`personalize` 工具与界面共用同一份规则。
 *
 * 不变量：
 * - 只有一套个性化，作用于界面骨架（外框、会话区、面板视图）。明暗由主题决定，不在此处设置；
 *   画布、终端、内置浏览器等内容区不受个性化影响。
 * - 校验严格拒绝：未知字段、越界数值、非法颜色一律返回错误，不做修正。修正后写入磁盘的值
 *   与调用方给出的值不一致，模型与用户都无法据此判断哪一项未生效。
 * - 图片只记录文件名，文件位于个性化目录中；不接受路径，路径解析只在落盘一侧进行。
 */

export type ImageFit = 'cover' | 'contain' | 'tile'

/** 渐变方向：水平（从左到右）、垂直（从上到下）、斜下（左上到右下）、斜上（左下到右上）。 */
export type GradientDirection = 'horizontal' | 'vertical' | 'diagonal-down' | 'diagonal-up'

export const GRADIENT_DIRECTIONS: readonly GradientDirection[] = [
  'horizontal',
  'vertical',
  'diagonal-down',
  'diagonal-up',
]

/** 各方向对应的 CSS `linear-gradient` 角度。 */
export const GRADIENT_ANGLE: Record<GradientDirection, number> = {
  horizontal: 90,
  vertical: 180,
  'diagonal-down': 135,
  'diagonal-up': 45,
}

/** 背景。纯色的 `color` 为 null 表示使用主题底色，即没有背景层。 */
export type PersonalBackground =
  | { kind: 'color'; color: string | null }
  | { kind: 'gradient'; from: string; to: string; direction: GradientDirection }
  | { kind: 'image'; file: string; fit: ImageFit; dim: number; blur: number }

export interface PersonalFog {
  color: string
  density: number
  speed: number
}

export interface Personalization {
  background: PersonalBackground
  /** 流动雾面。null 表示没有雾面。 */
  fog: PersonalFog | null
  /** 骨架底色的不透明度。1 表示与默认相同的不透明底色，此时背景与雾面被骨架完全遮住。 */
  opacity: number
  /** 强调色。null 表示使用主题的强调色。 */
  accent: string | null
  /**
   * 流动色：生成进度的色阶（画布连线的流动虚线、选中节点的连线、卡片上的生成中与排队中动画、读数条的进度方块、
   * 画布对齐线）由它推导。null 表示使用默认的紫色。不随强调色变化。
   */
  flow: string | null
}

/** 已保存的个性化。`updatedAt` 为 0 表示从未保存，内容即默认值。 */
export interface PersonalizationEntry {
  personalization: Personalization
  updatedAt: number
}

/** 图片背景允许的扩展名（小写、含点）。 */
export const PERSONAL_IMAGE_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.avif',
] as const

/** 各数值字段的取值范围，界面控件与校验使用同一份。 */
export const PERSONAL_LIMITS = {
  dim: [0, 0.9],
  imageBlur: [0, 40],
  density: [0, 1],
  speed: [0, 1],
  opacity: [0.2, 1],
} as const

export const DEFAULT_PERSONALIZATION: Personalization = {
  background: { kind: 'color', color: null },
  fog: null,
  opacity: 1,
  accent: null,
  flow: null,
}

/**
 * 背景层从看不到改为看得到时采用的界面不透明度。背景与雾面位于界面骨架之下，
 * 不透明度为 1 时被完全遮住，设置了背景却看不到变化。
 */
export const REVEAL_OPACITY = 0.85

/** 是否看得到背景层：纯色背景的颜色为 null 且没有雾面时，骨架下方只有页面底色。 */
export function backdropVisible(p: Personalization): boolean {
  return !(p.background.kind === 'color' && p.background.color === null) || p.fog !== null
}

/**
 * 一次修改使背景层从看不到变为看得到、且界面不透明度为 1 时，同一次修改把不透明度改为 `REVEAL_OPACITY`。
 * 设置页的编辑与设置背景图片的接口共用本规则。不要改为先保存修改、再单独保存不透明度：
 * 第一次保存的广播触发其他读取，读取结果晚于第二次的预览到达时覆盖预览，界面停留在不透明度 1。
 */
export function revealBackdrop(before: Personalization, after: Personalization): Personalization {
  return !backdropVisible(before) && backdropVisible(after) && after.opacity === 1
    ? { ...after, opacity: REVEAL_OPACITY }
    : after
}

/** 是否与默认值相同。 */
export function isDefaultPersonalization(p: Personalization): boolean {
  return (
    p.background.kind === 'color' &&
    p.background.color === null &&
    p.fog === null &&
    p.opacity === 1 &&
    p.accent === null &&
    p.flow === null
  )
}

const COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/** 图片文件名：单段、无路径分隔符、扩展名在允许列表中。 */
export function isPersonalImageName(name: string): boolean {
  if (!name || name.length > 128 || /[/\\]/.test(name) || name.includes('..')) return false
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return false
  return (PERSONAL_IMAGE_EXTENSIONS as readonly string[]).includes(name.slice(dot).toLowerCase())
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

class PersonalizationError extends Error {}

function fail(message: string): never {
  throw new PersonalizationError(message)
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

function background(raw: unknown): PersonalBackground {
  const kind = (raw as { kind?: unknown } | null)?.kind
  if (kind === 'color') {
    const o = record(raw, 'background', ['kind', 'color'])
    return { kind, color: o.color === null ? null : color(o.color, 'background.color') }
  }
  if (kind === 'gradient') {
    const o = record(raw, 'background', ['kind', 'from', 'to', 'direction'])
    if (!GRADIENT_DIRECTIONS.includes(o.direction as GradientDirection)) {
      fail(`background.direction 必须是 ${GRADIENT_DIRECTIONS.join('、')} 之一`)
    }
    return {
      kind,
      from: color(o.from, 'background.from'),
      to: color(o.to, 'background.to'),
      direction: o.direction as GradientDirection,
    }
  }
  if (kind === 'image') {
    const o = record(raw, 'background', ['kind', 'file', 'fit', 'dim', 'blur'])
    if (typeof o.file !== 'string' || !isPersonalImageName(o.file)) {
      fail(`background.file 必须是图片文件名（${PERSONAL_IMAGE_EXTENSIONS.join('、')}），不含路径`)
    }
    if (o.fit !== 'cover' && o.fit !== 'contain' && o.fit !== 'tile') {
      fail('background.fit 必须是 cover、contain 或 tile')
    }
    return {
      kind,
      file: o.file,
      fit: o.fit,
      dim: num(o.dim, 'background.dim', PERSONAL_LIMITS.dim),
      blur: num(o.blur, 'background.blur', PERSONAL_LIMITS.imageBlur),
    }
  }
  return fail('background.kind 必须是 color、gradient 或 image')
}

function fog(raw: unknown): PersonalFog | null {
  if (raw === null) return null
  const o = record(raw, 'fog', ['color', 'density', 'speed'])
  return {
    color: color(o.color, 'fog.color'),
    density: num(o.density, 'fog.density', PERSONAL_LIMITS.density),
    speed: num(o.speed, 'fog.speed', PERSONAL_LIMITS.speed),
  }
}

function personalizationOf(raw: unknown): Personalization {
  const o = record(raw, '个性化', ['background', 'fog', 'opacity', 'accent', 'flow'])
  return {
    background: background(o.background),
    fog: fog(o.fog),
    opacity: num(o.opacity, 'opacity', PERSONAL_LIMITS.opacity),
    accent: o.accent === null ? null : color(o.accent, 'accent'),
    // `flow` 晚于其他字段加入：此前保存的个性化文件没有该字段，缺省按 null（默认的紫色）读取，
    // 不要改为必填，否则这些文件无法读取，用户的个性化随之失效。
    flow: o.flow === undefined || o.flow === null ? null : color(o.flow, 'flow'),
  }
}

/** 校验一份完整的个性化。 */
export function parsePersonalization(raw: unknown): Parsed<Personalization> {
  try {
    return { ok: true, value: personalizationOf(raw) }
  } catch (e) {
    if (e instanceof PersonalizationError) return { ok: false, error: e.message }
    throw e
  }
}

/**
 * 把部分修改合并到已有个性化上，再整体校验。
 *
 * `background` 按 `kind` 合并：`kind` 相同时逐字段覆盖，不同时整组替换。不要改为深合并：
 * 从图片背景切换为纯色时，深合并会保留 `file` 等字段，结果因含无法识别的字段而被拒绝。
 * `fog` 为 null 时整组替换，已有雾面时逐字段覆盖。
 */
export function mergePersonalization(
  base: Personalization,
  patch: unknown,
): Parsed<Personalization> {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return { ok: false, error: '修改内容必须是对象' }
  }
  const p = patch as Record<string, unknown>
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
  const bg = p.background
  const nextBackground =
    bg === undefined
      ? base.background
      : isObject(bg) && (bg.kind === undefined || bg.kind === base.background.kind)
        ? { ...base.background, ...bg }
        : bg
  const fx = p.fog
  const nextFog =
    fx === undefined ? base.fog : isObject(fx) && base.fog ? { ...base.fog, ...fx } : fx
  return parsePersonalization({ ...base, ...p, background: nextBackground, fog: nextFog })
}
