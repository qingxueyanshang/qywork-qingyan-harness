/**
 * 图标集。
 *
 * 自己画而不用图标库，为的是三条能统一的规则——套用现成库时这三条几乎必然被打破：
 *
 * 1. **统一 24 网格、2.0 描边、round 端点与拐角。** 「圆润」是通过
 *    `stroke-linecap/linejoin: round` 落实的结构属性，不是靠给容器加圆角。
 *    描边取 2.0 是为了和参照物（青研魔盒用的 lucide）对齐——1.6 在 13/14px
 *    的实际显示尺寸下明显偏细，和旁边 500 字重的文字放在一起像是没加载完。
 * 2. **描边不随尺寸缩放**（`vector-effect: non-scaling-stroke`），
 *    16px 和 20px 下视觉粗细一致。
 * 3. **颜色恒为 currentColor**，由父级文字色决定，不在图标里写死颜色。
 */

import type { JSX } from 'solid-js'

interface IconProps {
  size?: number
  class?: string
  style?: JSX.CSSProperties
}

function Svg(props: IconProps & { children: JSX.Element; label?: string }) {
  return (
    <svg
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      vector-effect="non-scaling-stroke"
      class={props.class}
      style={props.style}
      aria-hidden={props.label ? undefined : true}
      aria-label={props.label}
      role={props.label ? 'img' : undefined}
    >
      {props.children}
    </svg>
  )
}

export const IconNewChat = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7.5A3.5 3.5 0 0 1 7.5 4h9A3.5 3.5 0 0 1 20 7.5v6a3.5 3.5 0 0 1-3.5 3.5H12l-4.2 3.2a.6.6 0 0 1-1-.5V17h-.3A3.5 3.5 0 0 1 4 13.5z" />
    <path d="M12 8.2v5M9.5 10.7h5" />
  </Svg>
)

/* ── 窗口按钮 ──
   刻意画得比其他图标细、比其他图标小：它们是系统级控件的替身，
   照 Windows 的观感应当是 1px 细线，跟 UI 图标的 2.0 描边不是一套语言。 */
export const IconWinMin = (p: IconProps) => (
  <svg width={p.size ?? 10} height={p.size ?? 10} viewBox="0 0 10 10" aria-hidden="true">
    <path d="M0 5h10" stroke="currentColor" stroke-width="1" />
  </svg>
)

export const IconWinMax = (p: IconProps & { restore?: boolean }) => (
  <svg
    width={p.size ?? 10}
    height={p.size ?? 10}
    viewBox="0 0 10 10"
    fill="none"
    aria-hidden="true"
  >
    {p.restore ? (
      <>
        <rect x="0.5" y="2.5" width="7" height="7" stroke="currentColor" stroke-width="1" />
        <path d="M2.5 2.5V0.5h7v7h-2" stroke="currentColor" stroke-width="1" />
      </>
    ) : (
      <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" stroke-width="1" />
    )}
  </svg>
)

export const IconWinClose = (p: IconProps) => (
  <svg width={p.size ?? 10} height={p.size ?? 10} viewBox="0 0 10 10" aria-hidden="true">
    <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" stroke-width="1" />
  </svg>
)

export const IconMic = (p: IconProps) => (
  <Svg {...p}>
    <rect x="9" y="3" width="6" height="10" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
    <path d="M12 17.5V21" />
  </Svg>
)

export const IconActivity = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 12h3.5l2.5-7 4 14 2.5-7H21" />
  </Svg>
)

export const IconBrain = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.5 4.5a2.6 2.6 0 0 0-2.6 2.6 2.6 2.6 0 0 0-1.4 4.6 2.7 2.7 0 0 0 1.6 4.5A2.6 2.6 0 0 0 12 18V6.9a2.4 2.4 0 0 0-2.5-2.4z" />
    <path d="M14.5 4.5a2.6 2.6 0 0 1 2.6 2.6 2.6 2.6 0 0 1 1.4 4.6 2.7 2.7 0 0 1-1.6 4.5A2.6 2.6 0 0 1 12 18" />
  </Svg>
)

export const IconClock = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 7.5V12l3 1.8" />
  </Svg>
)

export const IconBranch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="7" cy="5.5" r="2.2" />
    <circle cx="7" cy="18.5" r="2.2" />
    <circle cx="17" cy="9.5" r="2.2" />
    <path d="M7 7.7v8.6" />
    <path d="M17 11.7c0 3.2-2.4 4.6-5.2 5.1" />
  </Svg>
)

export const IconGlobe = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.2" />
    <path d="M3.8 12h16.4" />
    <path d="M12 3.8c2.1 2.3 3.2 5.2 3.2 8.2s-1.1 5.9-3.2 8.2c-2.1-2.3-3.2-5.2-3.2-8.2s1.1-5.9 3.2-8.2z" />
  </Svg>
)

export const IconPackage = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 8.4v7.2a2 2 0 0 1-1.05 1.76l-6 3.2a2 2 0 0 1-1.9 0l-6-3.2A2 2 0 0 1 4 15.6V8.4a2 2 0 0 1 1.05-1.76l6-3.2a2 2 0 0 1 1.9 0l6 3.2A2 2 0 0 1 20 8.4z" />
    <path d="M4.3 7.5 12 11.6l7.7-4.1M12 11.6V20.4" />
  </Svg>
)

export const IconPlug = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 3.8v4.4M15 3.8v4.4" />
    <path d="M6.6 8.2h10.8v3.6a5.4 5.4 0 0 1-10.8 0z" />
    <path d="M12 17.2v3" />
  </Svg>
)

export const IconFolder = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7.6A2.6 2.6 0 0 1 6.6 5h2.5a2 2 0 0 1 1.5.7l1 1.2h5.8A2.6 2.6 0 0 1 20 9.5v6.9A2.6 2.6 0 0 1 17.4 19H6.6A2.6 2.6 0 0 1 4 16.4z" />
  </Svg>
)

export const IconFile = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13.4 3.8H7.6A2.6 2.6 0 0 0 5 6.4v11.2a2.6 2.6 0 0 0 2.6 2.6h8.8a2.6 2.6 0 0 0 2.6-2.6V9.2z" />
    <path d="M13.4 3.8v3.8a1.6 1.6 0 0 0 1.6 1.6H19" />
  </Svg>
)

export const IconTerminal = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.2" y="4.6" width="17.6" height="14.8" rx="3.2" />
    <path d="M7.6 9.6 10.4 12l-2.8 2.4M12.8 14.8h3.6" />
  </Svg>
)

export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10.8" cy="10.8" r="6.4" />
    <path d="M15.6 15.6 20 20" />
  </Svg>
)

export const IconBell = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.4 10.4a5.6 5.6 0 0 1 11.2 0c0 4 1.4 5.4 1.4 5.4H5s1.4-1.4 1.4-5.4z" />
    <path d="M10.4 19a1.9 1.9 0 0 0 3.2 0" />
  </Svg>
)

const CHEVRON: Record<'down' | 'up' | 'right' | 'left', string> = {
  down: 'M5.6 9.5 12 16l6.4-6.5',
  up: 'M5.6 14.5 12 8l6.4 6.5',
  right: 'M9.5 5.6 16 12l-6.5 6.4',
  left: 'M14.5 5.6 8 12l6.5 6.4',
}
export const IconChevron = (p: IconProps & { dir?: 'down' | 'up' | 'right' | 'left' }) => (
  <Svg {...p}>
    <path d={CHEVRON[p.dir ?? 'down']} />
  </Svg>
)

export const IconSend = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.4 12h15.2M13.2 5.6 19.6 12l-6.4 6.4" />
  </Svg>
)

export const IconStop = (p: IconProps) => (
  <Svg {...p}>
    <rect x="6.4" y="6.4" width="11.2" height="11.2" rx="2.8" fill="currentColor" stroke="none" />
  </Svg>
)

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5.6v12.8M5.6 12h12.8" />
  </Svg>
)

export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5.2 12.6 9.6 17l9.2-10" />
  </Svg>
)

export const IconX = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.4 6.4l11.2 11.2M17.6 6.4 6.4 17.6" />
  </Svg>
)

export const IconShield = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.6 5.6 6v6c0 4 2.6 7.2 6.4 8.4 3.8-1.2 6.4-4.4 6.4-8.4V6z" />
    <path d="M9.4 12.2 11.4 14.2l3.4-3.8" />
  </Svg>
)

export const IconEye = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.8 12S6.6 5.8 12 5.8 21.2 12 21.2 12 17.4 18.2 12 18.2 2.8 12 2.8 12z" />
    <circle cx="12" cy="12" r="2.8" />
  </Svg>
)

export const IconPhone = (p: IconProps) => (
  <Svg {...p}>
    <rect x="7" y="2.8" width="10" height="18.4" rx="2.8" />
    <path d="M10.8 18.2h2.4" />
  </Svg>
)

export const IconPanel = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4.4" width="18" height="15.2" rx="2.4" />
    <path d="M14.6 4.4v15.2" />
  </Svg>
)

export const IconUsers = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="8.2" r="3.2" />
    <path d="M3.4 19.4c0-3 2.5-4.8 5.6-4.8s5.6 1.8 5.6 4.8" />
    <path d="M16.2 5.4a3.2 3.2 0 0 1 0 5.9" />
    <path d="M17.6 14.9c2.1.5 3.4 1.9 3.4 4.5" />
  </Svg>
)

export const IconSettings = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3.1" />
    <path d="M19.2 14.6a1.6 1.6 0 0 0 .32 1.76l.06.06a1.9 1.9 0 1 1-2.7 2.7l-.06-.06a1.6 1.6 0 0 0-1.76-.32 1.6 1.6 0 0 0-.97 1.47v.17a1.9 1.9 0 1 1-3.8 0v-.09a1.6 1.6 0 0 0-1.05-1.47 1.6 1.6 0 0 0-1.76.32l-.06.06a1.9 1.9 0 1 1-2.7-2.7l.06-.06a1.6 1.6 0 0 0 .32-1.76 1.6 1.6 0 0 0-1.47-.97H3.4a1.9 1.9 0 1 1 0-3.8h.09a1.6 1.6 0 0 0 1.47-1.05 1.6 1.6 0 0 0-.32-1.76l-.06-.06a1.9 1.9 0 1 1 2.7-2.7l.06.06a1.6 1.6 0 0 0 1.76.32h.08a1.6 1.6 0 0 0 .97-1.47V3.4a1.9 1.9 0 1 1 3.8 0v.09a1.6 1.6 0 0 0 .97 1.47 1.6 1.6 0 0 0 1.76-.32l.06-.06a1.9 1.9 0 1 1 2.7 2.7l-.06.06a1.6 1.6 0 0 0-.32 1.76v.08a1.6 1.6 0 0 0 1.47.97h.17a1.9 1.9 0 1 1 0 3.8h-.09a1.6 1.6 0 0 0-1.47.97z" />
  </Svg>
)

export const IconSpinner = (p: IconProps) => (
  <Svg {...p} class={`icon-spin ${p.class ?? ''}`}>
    <path d="M12 4.2v3.2" opacity="1" />
    <path d="M12 16.6v3.2" opacity="0.35" />
    <path d="M4.2 12h3.2" opacity="0.55" />
    <path d="M16.6 12h3.2" opacity="0.85" />
    <path d="m6.5 6.5 2.3 2.3" opacity="0.75" />
    <path d="m15.2 15.2 2.3 2.3" opacity="0.45" />
    <path d="m17.5 6.5-2.3 2.3" opacity="0.95" />
    <path d="m8.8 15.2-2.3 2.3" opacity="0.3" />
  </Svg>
)

/** 工具名 → 图标。找不到时回落到文件图标，不显示空白。 */
export function toolIcon(name: string): (p: IconProps) => JSX.Element {
  if (name === 'run_command') return IconTerminal
  if (name === 'grep' || name === 'glob') return IconSearch
  if (name === 'list_dir') return IconFolder
  if (name.startsWith('git')) return IconBranch
  if (name === 'web_fetch' || name === 'web_search') return IconGlobe
  return IconFile
}
