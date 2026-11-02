/**
 * 颜色换算：解析令牌与个性化中的色值，生成带透明度或混合后的 `rgba()`。
 *
 * 不使用 CSS 的 `color-mix()`：桌面端最低支持的 WebView2 110 没有该函数，
 * 声明会整条失效，骨架退回透明底色。
 */

export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

/** 解析 `#rgb` / `#rrggbb` / `#rrggbbaa` / `rgb()` / `rgba()`。无法解析时返回 null。 */
export function parseColor(value: string): Rgba | null {
  const v = value.trim().toLowerCase()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(v)?.[1]
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex
    const at = (i: number) => Number.parseInt(full.slice(i, i + 2), 16)
    return { r: at(0), g: at(2), b: at(4), a: full.length === 8 ? at(6) / 255 : 1 }
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(v)?.[1]
  if (fn) {
    const parts = fn
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number)
    if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null
    const [r = 0, g = 0, b = 0, a = 1] = parts
    return { r, g, b, a }
  }
  return null
}

export function toCss(c: Rgba): string {
  const ch = (n: number) => Math.round(Math.min(255, Math.max(0, n)))
  const a = Math.round(Math.min(1, Math.max(0, c.a)) * 1000) / 1000
  return `rgba(${ch(c.r)}, ${ch(c.g)}, ${ch(c.b)}, ${a})`
}

/** 原色的不透明度乘以 `alpha`。 */
export function withAlpha(c: Rgba, alpha: number): Rgba {
  return { ...c, a: c.a * alpha }
}

/** 按 `t`（0–1）由 `from` 向 `to` 线性混合，透明度取 `from` 的值。 */
export function mix(from: Rgba, to: Rgba, t: number): Rgba {
  const k = (x: number, y: number) => x + (y - x) * t
  return { r: k(from.r, to.r), g: k(from.g, to.g), b: k(from.b, to.b), a: from.a }
}

/** WCAG 相对亮度，0（黑）到 1（白）。 */
export function luminance(c: Rgba): number {
  const lin = (n: number) => {
    const s = n / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
}

/** WCAG 对比度，1 到 21。透明度不参与计算。 */
export function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * 叠在 `base` 上效果等于 `target` 的半透明黑色（`target` 较暗时）或白色（较亮时），不透明度按三个通道的平均取得。
 * 用于把不透明的色阶换成随底色透出背景的叠加色：叠在 `base` 本身上时与 `target` 相同。
 */
export function overlayFor(base: Rgba, target: Rgba): Rgba {
  const avg = (c: Rgba) => (c.r + c.g + c.b) / 3
  const b = avg(base)
  const t = avg(target)
  if (t <= b) return { r: 0, g: 0, b: 0, a: b === 0 ? 0 : 1 - t / b }
  return { r: 255, g: 255, b: 255, a: b === 255 ? 0 : (t - b) / (255 - b) }
}
