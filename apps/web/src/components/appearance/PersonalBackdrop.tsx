/**
 * 个性化的背景层：纯色、渐变或图片，加流动雾面。位于界面骨架之下，透过半透明的骨架底色显示。
 *
 * 只渲染 `paintedPersonalization()`，不自行读取：何时读取由个性化模块决定。
 * 纯色背景的颜色为 null 且没有雾面时不渲染：此时骨架下方只有页面底色。
 */

import { GRADIENT_ANGLE, type Personalization } from '@qywork/core'
import type { JSX } from 'solid-js'
import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { parseColor, toCss, withAlpha } from '../../lib/color.ts'
import { type PaintedPersonalization, paintedPersonalization } from '../../lib/store/index.ts'

/** 雾团数量。每团是一个径向渐变块，各自沿不同路径缓慢移动。 */
const FOG_BLOBS = 4

/** 速度 0 对应最慢一圈的时长，速度 1 对应最快一圈的时长（秒）。 */
const FOG_SLOWEST_S = 120
const FOG_FASTEST_S = 20

function backgroundStyle(p: PaintedPersonalization): JSX.CSSProperties {
  const bg = p.personalization.background
  if (bg.kind === 'color') return bg.color ? { 'background-color': bg.color } : {}
  if (bg.kind === 'gradient') {
    return {
      'background-image': `linear-gradient(${GRADIENT_ANGLE[bg.direction]}deg, ${bg.from}, ${bg.to})`,
    }
  }
  return {
    'background-image': p.imageUrl ? `url("${p.imageUrl}")` : 'none',
    'background-size': bg.fit === 'tile' ? 'auto' : bg.fit,
    'background-repeat': bg.fit === 'tile' ? 'repeat' : 'no-repeat',
    'background-position': 'center',
    filter: bg.blur > 0 ? `blur(${bg.blur}px)` : 'none',
    // 模糊会使四边向内渐隐为透明，层向外扩出两倍半径，渐隐部分落在窗口之外。
    inset: `-${bg.blur * 2}px`,
  }
}

function fogStyle(p: Personalization): JSX.CSSProperties | null {
  const fx = p.fog
  if (!fx) return null
  const color = parseColor(fx.color)
  if (!color) return null
  const duration = FOG_SLOWEST_S - (FOG_SLOWEST_S - FOG_FASTEST_S) * fx.speed
  return {
    '--fog-color': toCss(withAlpha(color, 0.12 + 0.48 * fx.density)),
    '--fog-duration': `${duration}s`,
  }
}

export function PersonalBackdrop() {
  // 窗口不可见时暂停雾面动画：后台运行的合成动画持续占用 GPU，而没有人在看。
  const [hidden, setHidden] = createSignal(document.hidden)
  onMount(() => {
    const sync = () => setHidden(document.hidden)
    document.addEventListener('visibilitychange', sync)
    onCleanup(() => document.removeEventListener('visibilitychange', sync))
  })

  return (
    <Show when={paintedPersonalization()}>
      {(p) => {
        const dim = () => {
          const bg = p().personalization.background
          return bg.kind === 'image' ? bg.dim : 0
        }
        return (
          <div class="personal-backdrop" aria-hidden="true">
            <div class="personal-layer" style={backgroundStyle(p())} />
            <Show when={dim() > 0}>
              <div class="personal-dim" style={{ opacity: dim() }} />
            </Show>
            <Show when={fogStyle(p().personalization)}>
              {(style) => (
                <div class="personal-fog" classList={{ paused: hidden() }} style={style()}>
                  <For each={Array.from({ length: FOG_BLOBS }, (_, i) => i)}>
                    {(i) => <i class={`fog-blob fog-blob-${i}`} />}
                  </For>
                </div>
              )}
            </Show>
          </div>
        )
      }}
    </Show>
  )
}
