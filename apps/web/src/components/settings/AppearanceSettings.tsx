/**
 * 外观：主题、皮肤与宠物。
 *
 * 选用皮肤时主题不生效（明暗取皮肤的模式），因此只在未选用皮肤时显示主题一行。
 * 皮肤的每项修改立即预览、停顿后保存（`editChosenSkin`），无需保存按钮。
 */

import { DEFAULT_SKIN, mergeSkin, SKIN_LIMITS, type Skin, type SkinImageFit } from '@qywork/core'
import { createSignal, For, type JSX, onMount, Show } from 'solid-js'
import {
  createSkin,
  editChosenSkin,
  effectiveTheme,
  type PetPlace,
  paintedSkin,
  petLibrary,
  petPrefs,
  refreshPetLibrary,
  refreshSkinLibrary,
  removePet,
  removeSkin,
  selectSkin,
  setPetPrefs,
  setSkinImage,
  setTheme,
  skinChoice,
  skinLibrary,
  skinSaveError,
  type ThemePref,
  theme,
} from '../../lib/store/index.ts'
import { DEFAULT_PET } from '../appearance/pet-default.ts'
import { ConfirmDialog } from '../ConfirmDialog.tsx'
import { OnOff } from './OnOff.tsx'
import { Section } from './Page.tsx'
import { Row } from './Row.tsx'

const THEMES: { id: ThemePref; label: string }[] = [
  { id: 'system', label: '跟随系统' },
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' },
]

const FITS: { id: SkinImageFit; label: string }[] = [
  { id: 'cover', label: '填充' },
  { id: 'contain', label: '适应' },
  { id: 'tile', label: '平铺' },
]

const PET_PLACES: { id: PetPlace; label: string }[] = [
  { id: 'app', label: '窗口内' },
  { id: 'hidden', label: '隐藏' },
]

/** 渐变新增色标时使用的颜色。 */
const NEW_STOP = '#3b3b48'

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
      <div class="skin-slider">
        <input
          type="range"
          aria-label={props.label}
          min={props.range[0]}
          max={props.range[1]}
          step={props.step}
          value={props.value}
          onInput={(e) => props.onInput(Number(e.currentTarget.value))}
        />
        <span class="skin-slider-value">{props.format(props.value)}</span>
      </div>
    </Row>
  )
}

function ColorInput(props: { label: string; value: string; onInput: (v: string) => void }) {
  // 颜色控件只接受 #rrggbb：带透明度或三位写法的值按六位写法显示。
  const hex = () => {
    const v = props.value
    if (/^#[0-9a-f]{3}$/i.test(v)) return `#${[...v.slice(1)].map((c) => c + c).join('')}`
    return v.slice(0, 7)
  }
  return (
    <input
      class="skin-color"
      type="color"
      aria-label={props.label}
      value={hex()}
      onInput={(e) => props.onInput(e.currentTarget.value)}
    />
  )
}

const percent = (v: number) => `${Math.round(v * 100)}%`

export function AppearanceSettings() {
  const [doomed, setDoomed] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  let picker: HTMLInputElement | undefined

  onMount(() => {
    const report = (e: unknown) => setError(e instanceof Error ? e.message : String(e))
    void refreshSkinLibrary().catch(report)
    void refreshPetLibrary().catch(report)
  })

  /** 正在编辑的皮肤：取正在显示的定义，它包含尚未写入的修改。 */
  const current = (): Skin | null => {
    const p = paintedSkin()
    return p && p.id === skinChoice()?.id ? p.skin : null
  }

  const edit = (patch: Record<string, unknown>) => {
    const skin = current()
    if (!skin) return
    const merged = mergeSkin(skin, patch)
    if (merged.ok) editChosenSkin(merged.value)
    else setError(merged.error)
  }

  const run = async (fn: () => Promise<unknown>) => {
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const create = () =>
    run(async () => {
      const entry = await createSkin({
        ...DEFAULT_SKIN,
        base: effectiveTheme() === 'light' ? 'light' : 'dark',
      })
      selectSkin(entry)
      await refreshSkinLibrary()
    })

  const pickImage = (file: File | undefined) => {
    const id = skinChoice()?.id
    if (!file || !id) return
    void run(async () => selectSkin(await setSkinImage(id, file.name, file)))
  }

  const remove = () => {
    const id = skinChoice()?.id
    setDoomed(false)
    if (id) void run(() => removeSkin(id))
  }

  const background = (skin: Skin): JSX.Element => {
    const bg = skin.background
    if (bg.kind === 'color') {
      return (
        <Row label="颜色">
          <ColorInput
            label="背景颜色"
            value={bg.color}
            onInput={(color) => edit({ background: { color } })}
          />
        </Row>
      )
    }
    if (bg.kind === 'gradient') {
      const stops = bg.stops
      const [, max] = SKIN_LIMITS.stops
      const [min] = SKIN_LIMITS.stops
      return (
        <>
          <Slider
            label="角度"
            value={bg.angle}
            range={SKIN_LIMITS.angle}
            step={1}
            format={(v) => `${v}°`}
            onInput={(angle) => edit({ background: { angle } })}
          />
          <Row label="颜色">
            <div class="skin-stops">
              <For each={stops}>
                {(c, i) => (
                  <ColorInput
                    label={`渐变颜色 ${i() + 1}`}
                    value={c}
                    onInput={(v) =>
                      edit({ background: { stops: stops.map((s, j) => (j === i() ? v : s)) } })
                    }
                  />
                )}
              </For>
              <button
                class="btn-ghost sm"
                type="button"
                disabled={stops.length <= min}
                onClick={() => edit({ background: { stops: stops.slice(0, -1) } })}
              >
                −
              </button>
              <button
                class="btn-ghost sm"
                type="button"
                disabled={stops.length >= max}
                onClick={() => edit({ background: { stops: [...stops, NEW_STOP] } })}
              >
                +
              </button>
            </div>
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
          range={SKIN_LIMITS.dim}
          step={0.05}
          format={percent}
          onInput={(dim) => edit({ background: { dim } })}
        />
        <Slider
          label="模糊"
          value={bg.blur}
          range={SKIN_LIMITS.imageBlur}
          step={1}
          format={(v) => `${v}px`}
          onInput={(blur) => edit({ background: { blur } })}
        />
      </>
    )
  }

  const kind = (skin: Skin) => skin.background.kind
  const pickKind = (skin: Skin, next: 'color' | 'gradient' | 'image') => {
    if (next === kind(skin)) return
    if (next === 'image') {
      picker?.click()
      return
    }
    const base = skin.base === 'light' ? '#f7f7f8' : '#0c0c0d'
    edit({
      background:
        next === 'color'
          ? { kind: 'color', color: base }
          : { kind: 'gradient', angle: 135, stops: [base, NEW_STOP] },
    })
  }

  return (
    <>
      <input
        ref={picker}
        class="skin-file"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
        onChange={(e) => {
          pickImage(e.currentTarget.files?.[0])
          e.currentTarget.value = ''
        }}
      />
      <Section
        title="皮肤"
        actions={
          <button class="btn-ghost sm" type="button" onClick={() => void create()}>
            新建
          </button>
        }
      >
        <div class="skin-list">
          <button
            class="seg-item"
            classList={{ active: !skinChoice() }}
            type="button"
            onClick={() => selectSkin(null)}
          >
            无
          </button>
          <For each={skinLibrary() ?? []}>
            {(entry) => (
              <button
                class="seg-item"
                classList={{ active: skinChoice()?.id === entry.id }}
                type="button"
                onClick={() => selectSkin(entry)}
              >
                {entry.skin.name}
              </button>
            )}
          </For>
        </div>
        <Show when={error() ?? skinSaveError()}>
          {(e) => <div class="settings-error">{e()}</div>}
        </Show>
      </Section>

      <Show when={!skinChoice()}>
        <Section title="主题">
          <div class="setting-rows">
            {/* 使用三态而不是深色开关：开关关闭后，系统切换为深色时应用是否跟随，
                界面上无法区分。`system` 必须单独作为一项。 */}
            <Row label="主题">
              <Seg items={THEMES} value={theme()} onPick={setTheme} />
            </Row>
          </div>
        </Section>
      </Show>

      <Show when={current()}>
        {(skin) => (
          <Section title={skin().name}>
            <div class="setting-rows">
              <Row label="名称">
                <input
                  type="text"
                  aria-label="皮肤名称"
                  maxLength={SKIN_LIMITS.name}
                  value={skin().name}
                  onChange={(e) => {
                    const name = e.currentTarget.value.trim()
                    if (name) edit({ name })
                  }}
                />
              </Row>
              <Row label="模式">
                <Seg
                  items={[
                    { id: 'light', label: '浅色' },
                    { id: 'dark', label: '深色' },
                  ]}
                  value={skin().base}
                  onPick={(base) => edit({ base })}
                />
              </Row>
              <Row label="背景">
                <Seg
                  items={[
                    { id: 'color', label: '纯色' },
                    { id: 'gradient', label: '渐变' },
                    { id: 'image', label: '图片' },
                  ]}
                  value={kind(skin())}
                  onPick={(next) => pickKind(skin(), next)}
                />
              </Row>
              {background(skin())}
              <Row label="流动雾面">
                <OnOff
                  on={skin().effect.kind === 'fog'}
                  onPick={(on) =>
                    edit({
                      effect: on
                        ? { kind: 'fog', color: '#ffffff', density: 0.5, speed: 0.4 }
                        : { kind: 'none' },
                    })
                  }
                />
              </Row>
              <Show when={skin().effect.kind === 'fog' && skin().effect}>
                {(fx) => {
                  const fog = () => fx() as Extract<Skin['effect'], { kind: 'fog' }>
                  return (
                    <>
                      <Row label="雾面颜色">
                        <ColorInput
                          label="雾面颜色"
                          value={fog().color}
                          onInput={(color) => edit({ effect: { color } })}
                        />
                      </Row>
                      <Slider
                        label="浓度"
                        value={fog().density}
                        range={SKIN_LIMITS.density}
                        step={0.05}
                        format={percent}
                        onInput={(density) => edit({ effect: { density } })}
                      />
                      <Slider
                        label="速度"
                        value={fog().speed}
                        range={SKIN_LIMITS.speed}
                        step={0.05}
                        format={percent}
                        onInput={(speed) => edit({ effect: { speed } })}
                      />
                    </>
                  )
                }}
              </Show>
              <Slider
                label="界面不透明度"
                value={skin().surface.opacity}
                range={SKIN_LIMITS.opacity}
                step={0.05}
                format={percent}
                onInput={(opacity) => edit({ surface: { opacity } })}
              />
              <Row label="强调色">
                <div class="skin-accent">
                  <OnOff
                    on={skin().accent !== null}
                    onPick={(on) => edit({ accent: on ? '#7c6cf0' : null })}
                  />
                  <Show when={skin().accent}>
                    {(accent) => (
                      <ColorInput
                        label="强调色"
                        value={accent()}
                        onInput={(v) => edit({ accent: v })}
                      />
                    )}
                  </Show>
                </div>
              </Row>
              <Row label="删除皮肤">
                <button class="btn-ghost sm" type="button" onClick={() => setDoomed(true)}>
                  删除
                </button>
              </Row>
            </div>
          </Section>
        )}
      </Show>

      <Section title="宠物">
        <div class="skin-list">
          <button
            class="seg-item"
            classList={{ active: petPrefs().pack === null }}
            type="button"
            onClick={() => setPetPrefs({ pack: null })}
          >
            {DEFAULT_PET.name}
          </button>
          <For each={petLibrary() ?? []}>
            {(entry) => (
              <button
                class="seg-item"
                classList={{ active: petPrefs().pack === entry.id }}
                type="button"
                onClick={() => setPetPrefs({ pack: entry.id })}
              >
                {entry.pack.name}
              </button>
            )}
          </For>
        </div>
        <div class="setting-rows">
          <Row label="显示位置">
            <Seg
              items={PET_PLACES}
              value={petPrefs().place}
              onPick={(place) => setPetPrefs({ place })}
            />
          </Row>
          <Show when={petPrefs().pack}>
            {(id) => (
              <Row label="删除宠物">
                <button
                  class="btn-ghost sm"
                  type="button"
                  onClick={() => void run(() => removePet(id()))}
                >
                  删除
                </button>
              </Row>
            )}
          </Show>
        </div>
      </Section>

      <ConfirmDialog
        open={doomed()}
        title="删除皮肤？"
        confirmLabel="删除"
        danger
        onConfirm={remove}
        onCancel={() => setDoomed(false)}
      />
    </>
  )
}
