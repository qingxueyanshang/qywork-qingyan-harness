/**
 * 宠物包的格式与校验。宠物库接口、`pet` 工具与界面共用同一份规则。
 *
 * 不变量：
 * - 五个状态全部必填。缺少某个状态时宠物在该状态下无图可显示，校验时拒绝而不是回退到其他状态。
 * - 帧只记录文件名，文件位于该宠物包自己的目录中；同一文件名可在帧序列中重复出现，用于控制各帧的停留时长。
 * - 宠物包只含图片与对应关系，不含代码。
 */

/** 宠物的五个状态，按显示优先级从高到低。界面的心情推导取同一组名称。 */
export const PET_STATES = ['desktop', 'failed', 'working', 'done', 'idle'] as const

export type PetState = (typeof PET_STATES)[number]

export interface PetAnimation {
  /** 帧图片的文件名，按顺序循环播放。 */
  frames: string[]
  /** 每秒帧数。 */
  fps: number
}

export interface PetPack {
  name: string
  /** 显示尺寸，CSS 像素（正方形）。 */
  size: number
  states: Record<PetState, PetAnimation>
}

export interface PetEntry {
  id: string
  pack: PetPack
  updatedAt: number
}

/** 帧图片允许的扩展名（小写、含点）。SVG 以 `<img>` 显示，其中的脚本不会执行。 */
export const PET_IMAGE_EXTENSIONS = ['.png', '.webp', '.gif', '.svg', '.jpg', '.jpeg'] as const

export const PET_LIMITS = {
  size: [48, 160],
  frames: [1, 24],
  fps: [1, 24],
  name: 40,
} as const

export function isPetId(id: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)
}

export function isPetImageName(name: string): boolean {
  if (!name || name.length > 128 || /[/\\]/.test(name) || name.includes('..')) return false
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return false
  return (PET_IMAGE_EXTENSIONS as readonly string[]).includes(name.slice(dot).toLowerCase())
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

function inRange(v: unknown, [min, max]: readonly [number, number]): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
}

/** 校验一份宠物包。 */
export function parsePetPack(raw: unknown): Parsed<PetPack> {
  const fail = (error: string): Parsed<PetPack> => ({ ok: false, error })
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('宠物包必须是对象')
  const o = raw as Record<string, unknown>
  for (const key of Object.keys(o)) {
    if (!['name', 'size', 'states'].includes(key)) return fail(`宠物包中有无法识别的字段：${key}`)
  }
  const name = typeof o.name === 'string' ? o.name.trim() : ''
  if (!name || name.length > PET_LIMITS.name)
    return fail(`name 必须是 1 到 ${PET_LIMITS.name} 个字符`)
  if (!inRange(o.size, PET_LIMITS.size)) {
    return fail(`size 必须是 ${PET_LIMITS.size[0]} 到 ${PET_LIMITS.size[1]} 之间的整数`)
  }
  if (typeof o.states !== 'object' || o.states === null || Array.isArray(o.states)) {
    return fail('states 必须是对象')
  }
  const src = o.states as Record<string, unknown>
  for (const key of Object.keys(src)) {
    if (!(PET_STATES as readonly string[]).includes(key))
      return fail(`states 中有无法识别的状态：${key}`)
  }
  const states = {} as Record<PetState, PetAnimation>
  for (const state of PET_STATES) {
    const a = src[state] as Record<string, unknown> | undefined
    if (typeof a !== 'object' || a === null) return fail(`缺少状态 ${state}`)
    for (const key of Object.keys(a)) {
      if (key !== 'frames' && key !== 'fps')
        return fail(`states.${state} 中有无法识别的字段：${key}`)
    }
    const [lo, hi] = PET_LIMITS.frames
    if (!Array.isArray(a.frames) || a.frames.length < lo || a.frames.length > hi) {
      return fail(`states.${state}.frames 必须是 ${lo} 到 ${hi} 个文件名`)
    }
    for (const f of a.frames) {
      if (typeof f !== 'string' || !isPetImageName(f)) {
        return fail(
          `states.${state}.frames 中的文件名不合法：${String(f)}（${PET_IMAGE_EXTENSIONS.join('、')}，不含路径）`,
        )
      }
    }
    if (!inRange(a.fps, PET_LIMITS.fps)) {
      return fail(
        `states.${state}.fps 必须是 ${PET_LIMITS.fps[0]} 到 ${PET_LIMITS.fps[1]} 之间的整数`,
      )
    }
    states[state] = { frames: [...(a.frames as string[])], fps: a.fps }
  }
  return { ok: true, value: { name, size: o.size, states } }
}

/** 宠物包引用的全部文件名，去重。 */
export function petFrameFiles(pack: PetPack): string[] {
  return [...new Set(PET_STATES.flatMap((s) => pack.states[s].frames))]
}
