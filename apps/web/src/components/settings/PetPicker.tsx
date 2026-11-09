import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js'
import { petLibrary, petPack, petPrefs, removePet, setPetPrefs } from '../../lib/store/index.ts'
import { AnchoredMenu } from '../AnchoredMenu.tsx'
import { DEFAULT_PET } from '../appearance/pet-default.ts'
import { ConfirmDialog } from '../ConfirmDialog.tsx'
import { IconCheck, IconChevron, IconTrash } from '../Icons.tsx'

/**
 * 宠物皮肤的下拉菜单：每行是一只宠物，用户宠物的行尾带删除按钮。
 *
 * **不使用原生 `<select>`。** 宠物库在设置页打开后才读取，原生下拉框的 value 先于选项写入时
 * 落到第一项（内置宠物），选项随后插入也不会再改回，重新打开设置页总显示内置宠物。
 * 此处当前项的名称由偏好与已读取的宠物包直接计算，与选项何时到达无关。
 *
 * 删除按钮放在每一行中，而不是下拉框外：放在外面只能删除当前选中的一只，且看不出删的是哪一只。
 * 删除移除本机的宠物目录，不可恢复，点击后先收起菜单再弹出确认。
 */
export function PetPicker(props: { onError: (message: string | null) => void }) {
  const [open, setOpen] = createSignal(false)
  /** 等待确认删除的宠物。 */
  const [doomed, setDoomed] = createSignal<{ id: string; name: string } | null>(null)
  let field!: HTMLDivElement
  let trigger!: HTMLButtonElement
  let menu: HTMLDivElement | undefined

  /** 当前宠物的名称。宠物库尚未读取时取已加载的宠物包，两者都没有时显示 id，而不是内置宠物的名称。 */
  const currentName = () => {
    const id = petPrefs().pack
    if (!id) return DEFAULT_PET.name
    return (
      petLibrary()?.find((e) => e.id === id)?.pack.name ??
      (petPack()?.id === id ? petPack()?.pack.name : undefined) ??
      id
    )
  }

  const close = (focus = false) => {
    setOpen(false)
    if (focus) trigger.focus()
  }
  const pick = (id: string | null) => {
    setPetPrefs({ pack: id })
    close(true)
  }
  const remove = (id: string) => {
    setDoomed(null)
    props.onError(null)
    void removePet(id).catch((e: unknown) =>
      props.onError(e instanceof Error ? e.message : String(e)),
    )
  }

  // 确认框打开时，Escape 只取消删除。设置弹窗同样在 window 上监听 Escape，此处在 document 的捕获阶段拦下，
  // 否则一次 Escape 会连同设置弹窗一起关闭。
  createEffect(() => {
    if (!doomed()) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      setDoomed(null)
    }
    document.addEventListener('keydown', onKey, true)
    onCleanup(() => document.removeEventListener('keydown', onKey, true))
  })

  const options = () => [...(menu?.querySelectorAll<HTMLButtonElement>('[data-pet-option]') ?? [])]
  const move = (e: KeyboardEvent) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
    const list = options()
    if (!list.length) return
    e.preventDefault()
    const i = list.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? list.length - 1
          : (i + (e.key === 'ArrowUp' ? -1 : 1) + list.length) % list.length
    list[next]?.focus()
  }

  // 展开期间：点击外部收起；Escape 只收起菜单，不关闭整个设置弹窗（弹窗在 window 上监听 Escape）。
  createEffect(() => {
    if (!open()) return
    queueMicrotask(() => {
      const list = options()
      ;(list.find((b) => b.getAttribute('aria-checked') === 'true') ?? list[0])?.focus()
    })
    const outside = (e: Event) => {
      const target = e.target as Node
      if (field.contains(target) || menu?.contains(target)) return
      close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      close(true)
    }
    const onResize = () => close()
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', onResize)
    onCleanup(() => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', onResize)
    })
  })

  const row = (id: string | null, name: string) => {
    const checked = () => (petPrefs().pack ?? null) === id
    return (
      <div class="pet-option" classList={{ selected: checked() }}>
        <button
          data-pet-option
          type="button"
          role="menuitemradio"
          aria-checked={checked()}
          data-tip={name}
          onKeyDown={move}
          onClick={() => pick(id)}
        >
          <span class="truncate">{name}</span>
          <Show when={checked()}>
            <IconCheck size={12} />
          </Show>
        </button>
        <Show when={id}>
          {(packId) => (
            <button
              class="pet-option-remove"
              type="button"
              aria-label={`删除 ${name}`}
              data-tip="删除"
              onClick={() => {
                close()
                setDoomed({ id: packId(), name })
              }}
            >
              <IconTrash size={13} />
            </button>
          )}
        </Show>
      </div>
    )
  }

  return (
    <div class="pet-pick" ref={field}>
      <button
        ref={trigger}
        class="pet-pick-trigger"
        type="button"
        aria-label="宠物皮肤"
        aria-haspopup="menu"
        aria-expanded={open()}
        data-tip={currentName()}
        onClick={() => (open() ? close() : setOpen(true))}
        onKeyDown={(e) => {
          if (!open() && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault()
            setOpen(true)
          }
        }}
      >
        <span class="truncate">{currentName()}</span>
        <IconChevron size={12} dir={open() ? 'up' : 'down'} />
      </button>
      <Show when={open()}>
        <AnchoredMenu class="pet-pick-menu" anchor={trigger}>
          <div ref={menu} class="pet-pick-options">
            {row(null, DEFAULT_PET.name)}
            <For each={petLibrary() ?? []}>{(entry) => row(entry.id, entry.pack.name)}</For>
          </div>
        </AnchoredMenu>
      </Show>
      <ConfirmDialog
        open={doomed() !== null}
        title={`删除宠物「${doomed()?.name ?? ''}」`}
        message={
          doomed()?.id === petPrefs().pack
            ? '它是当前使用的宠物，删除后换回内置宠物。删除后无法恢复。'
            : '删除后无法恢复。'
        }
        confirmLabel="删除"
        danger
        onConfirm={() => {
          const target = doomed()
          if (target) remove(target.id)
        }}
        onCancel={() => setDoomed(null)}
      />
    </div>
  )
}
