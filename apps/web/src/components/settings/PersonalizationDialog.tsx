/**
 * 个性化：从「通用」页「个性化」一行打开的弹窗，结构同「拉取模型」。只有一套设置，打开即当前值。
 *
 * 每项修改立即预览、停顿后保存（`editPersonalization`），没有保存按钮。窗口尺寸固定（B9），
 * 高度容纳行数最多的情形，切换背景类型、设置雾面时按钮位置不变。
 * 弹窗没有遮罩：修改时需要看到窗口四周的效果，设置窗口自身已有遮罩。
 */

import {
  type GradientDirection,
  type ImageFit,
  isDefaultPersonalization,
  mergePersonalization,
  PERSONAL_LIMITS,
  type PersonalBackground,
  type Personalization,
} from '@qywork/core'
import { createSignal, For, type JSX, onCleanup, onMount, Show } from 'solid-js'
import {
  currentPersonalization,
  editPersonalization,
  personalizationError,
  resetPersonalization,
  setPersonalImage,
} from '../../lib/store/index.ts'
import { ColorWell } from './ColorWell.tsx'
import { Row } from './Row.tsx'

const KINDS: { id: PersonalBackground['kind']; label: string }[] = [
  { id: 'color', label: '纯色' },
  { id: 'gradient', label: '渐变' },
  { id: 'image', label: '图片' },
]

const DIRECTIONS: { id: GradientDirection; label: string }[] = [
  { id: 'horizontal', label: '水平' },
  { id: 'vertical', label: '垂直' },
  { id: 'diagonal-down', label: '斜下' },
  { id: 'diagonal-up', label: '斜上' },
]

const FITS: { id: ImageFit; label: string }[] = [
  { id: 'cover', label: '填充' },
  { id: 'contain', label: '适应' },
  { id: 'tile', label: '平铺' },
]

/** 改为渐变背景时的初始颜色。 */
const GRADIENT_FROM = '#6366f1'
const GRADIENT_TO = '#06b6d4'

/** 设置雾面时浓度与速度的初始值。 */
const FOG_DENSITY = 0.5
const FOG_SPEED = 0.4

/**
 * 从「看不到背景」改为有背景或雾面时采用的界面不透明度。背景与雾面位于界面骨架之下，
 * 不透明度为 100% 时被完全遮住，选了颜色却看不到变化。
 */
const REVEAL_OPACITY = 0.85

function Seg<T extends string>(props: {
  items: { id: T; label: string }[]
  value: T
  onPick: (id: T) => void
}) {
  return (
    <div class="seg">
      <For each={props.items}>
        {(it) => (
          <button
            class="seg-item"
            classList={{ active: props.value === it.id }}
            type="button"
            onClick={() => props.onPick(it.id)}
          >
            {it.label}
          </button>
        )}
      </For>
    </div>
  )
}

/** 滑块与当前值。`format` 把数值转为显示文字。 */
function Slider(props: {
  label: string
  value: number
  range: readonly [number, number]
  step: number
  format: (v: number) => string
  onInput: (v: number) => void
}) {
  return (
    <Row label={props.label}>
      <div class="personal-slider">
        <input
          type="range"
          aria-label={props.label}
          min={props.range[0]}
          max={props.range[1]}
          step={props.step}
          value={props.value}
          onInput={(e) => props.onInput(Number(e.currentTarget.value))}
        />
        <span class="personal-slider-value">{props.format(props.value)}</span>
      </div>
    </Row>
  )
}

const percent = (v: number) => `${Math.round(v * 100)}%`

/** 是否看得到背景层：纯色背景的颜色为空且没有雾面时，骨架下方只有页面底色。 */
function backdropVisible(p: Personalization): boolean {
  return !(p.background.kind === 'color' && p.background.color === null) || p.fog !== null
}

/**
 * 恢复默认的确认。个性化弹窗是原生模态窗口，位于顶层；普通的确认浮层会被它遮住，
 * 因此确认同样用原生模态窗口，叠在其上。
 */
function ResetDialog(props: { onConfirm: () => void; onCancel: () => void }) {
  let dialog!: HTMLDialogElement
  onMount(() => dialog.showModal())
  onCleanup(() => dialog.close())
  return (
    <dialog
      ref={dialog}
      class="personal-reset-dialog"
      aria-label="恢复默认？"
      onCancel={(e) => {
        e.preventDefault()
        props.onCancel()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') e.stopPropagation()
      }}
    >
      <h2 class="confirm-title">恢复默认？</h2>
      <div class="confirm-actions">
        <button class="btn-ghost" type="button" onClick={props.onCancel}>
          取消
        </button>
        <button class="btn-primary" type="button" onClick={props.onConfirm}>
          恢复默认
        </button>
      </div>
    </dialog>
  )
}

export function PersonalizationDialog(props: { onClose: () => void }) {
  let dialog!: HTMLDialogElement
  let picker: HTMLInputElement | undefined
  const [confirming, setConfirming] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  onMount(() => dialog.showModal())
  onCleanup(() => dialog.close())

  const p = currentPersonalization

  /**
   * 合并一项修改并预览。`reveal` 为真且修改前看不到背景时，同一次修改把 100% 的不透明度降为
   * `REVEAL_OPACITY`，理由见该常量。
   */
  const edit = (patch: Record<string, unknown>, reveal = false) => {
    const before = p()
    const next =
      reveal && !backdropVisible(before) && before.opacity === 1
        ? { ...patch, opacity: REVEAL_OPACITY }
        : patch
    const merged = mergePersonalization(before, next)
    if (merged.ok) {
      setError(null)
      editPersonalization(merged.value)
    } else setError(merged.error)
  }

  const run = async (fn: () => Promise<unknown>) => {
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const pickImage = (file: File | undefined) => {
    if (!file) return
    const reveal = !backdropVisible(p()) && p().opacity === 1
    void run(async () => {
      await setPersonalImage(file.name, file)
      if (reveal) edit({ opacity: REVEAL_OPACITY })
    })
  }

  const pickKind = (next: PersonalBackground['kind']) => {
    if (next === p().background.kind) return
    if (next === 'image') {
      picker?.click()
      return
    }
    if (next === 'color') edit({ background: { kind: 'color', color: null } })
    else
      edit(
        {
          background: {
            kind: 'gradient',
            from: GRADIENT_FROM,
            to: GRADIENT_TO,
            direction: 'diagonal-down',
          },
        },
        true,
      )
  }

  const backgroundRows = (): JSX.Element => {
    const bg = p().background
    if (bg.kind === 'color') {
      return (
        <Row label="颜色">
          <ColorWell
            label="背景颜色"
            value={bg.color}
            emptyLabel="默认"
            onPick={(color) => edit({ background: { color } }, color !== null)}
          />
        </Row>
      )
    }
    if (bg.kind === 'gradient') {
      return (
        <>
          <Row label="起始颜色">
            <ColorWell
              label="起始颜色"
              value={bg.from}
              onPick={(from) => from && edit({ background: { from } })}
            />
          </Row>
          <Row label="结束颜色">
            <ColorWell
              label="结束颜色"
              value={bg.to}
              onPick={(to) => to && edit({ background: { to } })}
            />
          </Row>
          <Row label="方向">
            <Seg
              items={DIRECTIONS}
              value={bg.direction}
              onPick={(direction) => edit({ background: { direction } })}
            />
          </Row>
        </>
      )
    }
    return (
      <>
        <Row label="图片">
          <button class="btn-ghost sm" type="button" onClick={() => picker?.click()}>
            更换
          </button>
        </Row>
        <Row label="填充">
          <Seg items={FITS} value={bg.fit} onPick={(fit) => edit({ background: { fit } })} />
        </Row>
        <Slider
          label="暗度"
          value={bg.dim}
          range={PERSONAL_LIMITS.dim}
          step={0.05}
          format={percent}
          onInput={(dim) => edit({ background: { dim } })}
        />
        <Slider
          label="模糊"
          value={bg.blur}
          range={PERSONAL_LIMITS.imageBlur}
          step={1}
          format={(v) => `${v}px`}
          onInput={(blur) => edit({ background: { blur } })}
        />
      </>
    )
  }

  return (
    <dialog
      ref={dialog}
      class="personal-dialog"
      aria-label="个性化"
      onCancel={(e) => {
        e.preventDefault()
        props.onClose()
      }}
      onKeyDown={(e) => {
        // Escape 只关闭本窗口，不把后面的设置窗口一起关闭。
        if (e.key === 'Escape') e.stopPropagation()
      }}
    >
      <h2 class="confirm-title">个性化</h2>
      <input
        ref={picker}
        class="personal-file"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
        onChange={(e) => {
          pickImage(e.currentTarget.files?.[0])
          e.currentTarget.value = ''
        }}
      />
      <section class="personal-editor">
        <div class="setting-rows">
          <Row label="背景">
            <Seg items={KINDS} value={p().background.kind} onPick={pickKind} />
          </Row>
          {backgroundRows()}
          <Row label="雾面">
            <ColorWell
              label="雾面颜色"
              value={p().fog?.color ?? null}
              emptyLabel="无"
              onPick={(color) =>
                color === null
                  ? edit({ fog: null })
                  : p().fog
                    ? edit({ fog: { color } })
                    : edit({ fog: { color, density: FOG_DENSITY, speed: FOG_SPEED } }, true)
              }
            />
          </Row>
          <Show when={p().fog}>
            {(fog) => (
              <>
                <Slider
                  label="浓度"
                  value={fog().density}
                  range={PERSONAL_LIMITS.density}
                  step={0.05}
                  format={percent}
                  onInput={(density) => edit({ fog: { density } })}
                />
                <Slider
                  label="速度"
                  value={fog().speed}
                  range={PERSONAL_LIMITS.speed}
                  step={0.05}
                  format={percent}
                  onInput={(speed) => edit({ fog: { speed } })}
                />
              </>
            )}
          </Show>
          <Slider
            label="界面不透明度"
            value={p().opacity}
            range={PERSONAL_LIMITS.opacity}
            step={0.05}
            format={percent}
            onInput={(opacity) => edit({ opacity })}
          />
          <Row label="强调色">
            <ColorWell
              label="强调色"
              value={p().accent}
              emptyLabel="默认"
              onPick={(accent) => edit({ accent })}
            />
          </Row>
        </div>
      </section>
      <div class="confirm-actions personal-actions">
        <span
          class="personal-error truncate"
          role="alert"
          data-tip={error() ?? personalizationError() ?? ''}
        >
          {error() ?? personalizationError() ?? ''}
        </span>
        <button
          class="btn-ghost"
          type="button"
          disabled={isDefaultPersonalization(p())}
          onClick={() => setConfirming(true)}
        >
          恢复默认
        </button>
        <button class="btn-primary" type="button" onClick={props.onClose}>
          完成
        </button>
      </div>
      <Show when={confirming()}>
        <ResetDialog
          onConfirm={() => {
            setConfirming(false)
            void run(resetPersonalization)
          }}
          onCancel={() => setConfirming(false)}
        />
      </Show>
    </dialog>
  )
}
