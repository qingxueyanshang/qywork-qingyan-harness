import type { Conversation } from '@qywork/core'
import { createSignal, onCleanup, onMount, Show } from 'solid-js'
import { archiveConversation, deleteConversation, renameConversation } from '../lib/store/index.ts'
import { AnchoredMenu } from './AnchoredMenu.tsx'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { IconArchive, IconMore, IconPencil, IconX } from './Icons.tsx'

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * 侧栏那一行的时间：今天给时刻，昨天给「昨天」，更早给日期。
 *
 * **不写「N 分钟前」**：相对时间需要定时重渲染，否则渲染后即过期。
 * 按当日零点分界，不按「差 24 小时」：凌晨一点的消息当晚应显示为「昨天」。
 */
function fmtWhen(t: number): string {
  const d = new Date(t)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (t >= today) return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (t >= new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime()) return '昨天'
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}-${d.getDate()}`
  return `${String(d.getFullYear()).slice(2)}-${d.getMonth() + 1}-${d.getDate()}`
}

/**
 * 一行会话：标题 + 最近修改时间 + `⋯` 菜单（重命名 / 归档 / 删除）。
 *
 * 整行是 button，`⋯` 也是 button，**两个 button 不能嵌套**（浏览器会把内层拎出去，
 * 点击区随之错位），所以外层只能是 div。
 *
 * 菜单与 `ProjectRow` 的各写各的：项完全不同，抽通用组件要先有第三个调用点（B2）；
 * `.conv-menu` 的样式同样自带完整规则，不与 `.project-menu` 共用选择器（B8）。
 */
export function ConversationRow(props: {
  conversation: Conversation
  active: boolean
  /** 这条会话正在跑。**列表里每一条都判得出**，判据是 `state.busyConversations`。 */
  running: boolean
  onOpen: () => void
  onError?: (message: string) => void
}) {
  const [menuOpen, setMenuOpen] = createSignal(false)
  const [renaming, setRenaming] = createSignal(false)
  /** 正在等确认的动作。null = 没有。同时只可能有一个。 */
  const [armed, setArmed] = createSignal<'archive' | 'delete' | null>(null)

  const close = () => {
    setMenuOpen(false)
    setArmed(null)
  }

  /** 菜单卡片钉在这颗 `⋯` 上，收起判断也按这一行的容器算。 */
  let wrapEl: HTMLDivElement | undefined
  let moreEl!: HTMLButtonElement

  /*
   * 点到本行之外就收起菜单。捕获阶段监听，免得被内部的 stopPropagation 吃掉。
   *
   * **按本行的容器判，不用类选择器**：`closest('.conv-menu-wrap')` 对别的会话行
   * 同样成立，点另一行的 `⋯` 时这一行的菜单不关，两张卡片叠在一起。
   *
   * **确认弹窗打开时一律不处理**：它渲染在 `.conv-menu-wrap` 之外，确认键的
   * mousedown 会先命中这里并清掉 `armed`，弹窗随之卸载，click 不再触发。
   */
  const onDocDown = (e: MouseEvent) => {
    if (armed() !== null) return
    const t = e.target as Node | null
    if (!t || !wrapEl?.contains(t)) setMenuOpen(false)
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close()
  }
  /*
   * 卡片是 fixed 的，坐标只在展开那一刻算一次——列表滚动或窗口改尺寸之后它会停在
   * 原地，与那一行脱节，所以收起来让用户重开。确认弹窗立着时不动它：那时菜单在
   * 弹窗后面，收掉会连着把弹窗的来源一起抽走。
   * scroll 不冒泡，容器内的滚动只有捕获阶段收得到。
   */
  const onReflow = () => {
    if (armed() === null) setMenuOpen(false)
  }
  document.addEventListener('mousedown', onDocDown, true)
  document.addEventListener('keydown', onKey)
  document.addEventListener('scroll', onReflow, true)
  window.addEventListener('resize', onReflow)
  onCleanup(() => {
    document.removeEventListener('mousedown', onDocDown, true)
    document.removeEventListener('keydown', onKey)
    document.removeEventListener('scroll', onReflow, true)
    window.removeEventListener('resize', onReflow)
  })

  /** 每个动作都走这里：统一收起菜单、统一把失败说出来，不静默吞掉。 */
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn()
      close()
    } catch (e) {
      close()
      props.onError?.(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div class="conv-row" classList={{ active: props.active }}>
      <Show
        when={renaming()}
        fallback={
          <>
            <button class="conv-open" type="button" onClick={() => props.onOpen()}>
              <span class="truncate">{props.conversation.title || '新对话'}</span>
              {/* `aria-hidden`：它是会话流那条读数条的余光重复，读屏那边已经听到了。 */}
              <Show when={props.running}>
                <span class="conv-run" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                  <span />
                  <span />
                </span>
              </Show>
            </button>

            <span class="conv-time">{fmtWhen(props.conversation.updatedAt)}</span>

            <div
              class="conv-menu-wrap"
              ref={(el) => {
                wrapEl = el
              }}
            >
              <button
                class="icon-btn conv-more"
                ref={moreEl}
                type="button"
                aria-label={`${props.conversation.title || '新对话'} 的更多操作`}
                aria-expanded={menuOpen()}
                onClick={() => {
                  setMenuOpen(!menuOpen())
                  setArmed(null)
                }}
              >
                <IconMore size={14} />
              </button>

              <Show when={menuOpen()}>
                <AnchoredMenu class="conv-menu" anchor={moreEl}>
                  <button
                    class="conv-menu-item"
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false)
                      setRenaming(true)
                    }}
                  >
                    <IconPencil size={14} />
                    重命名
                  </button>
                  <button
                    class="conv-menu-item"
                    type="button"
                    role="menuitem"
                    onClick={() => setArmed('archive')}
                  >
                    <IconArchive size={14} />
                    归档
                  </button>
                  <button
                    class="conv-menu-item danger"
                    type="button"
                    role="menuitem"
                    onClick={() => setArmed('delete')}
                  >
                    <IconX size={14} />
                    删除
                  </button>
                </AnchoredMenu>
              </Show>
            </div>
          </>
        }
      >
        <RenameInput
          value={props.conversation.title}
          onCancel={() => setRenaming(false)}
          onSubmit={(title) => {
            setRenaming(false)
            void run(() => renameConversation(props.conversation.id, title))
          }}
        />
      </Show>

      {/* 确认是弹窗，不在行里就地展开——232px 的栏放不下。 */}
      <ConfirmDialog
        open={armed() !== null}
        title={armed() === 'delete' ? '删除这条会话？' : '归档这条会话？'}
        message={armed() === 'delete' ? '删了拿不回来。' : '归档后在界面上找不回来。'}
        confirmLabel={armed() === 'delete' ? '删除' : '归档'}
        danger={armed() === 'delete'}
        onConfirm={() =>
          void run(() =>
            armed() === 'delete'
              ? deleteConversation(props.conversation.id)
              : archiveConversation(props.conversation.id),
          )
        }
        onCancel={() => setArmed(null)}
      />
    </div>
  )
}

/**
 * 行内改名。
 *
 * **自己取焦点，不用 `autofocus`**：该属性只在文档解析时生效，而这一格是动态插入的。
 * 连带失效的是失焦即取消（未获得过焦点就不会失焦），输入框将无法退出。
 */
function RenameInput(props: {
  value: string
  onSubmit: (title: string) => void
  onCancel: () => void
}) {
  const [name, setName] = createSignal(props.value)
  let input!: HTMLInputElement
  onMount(() => {
    input.focus()
    input.select()
  })

  const submit = () => {
    const title = name().trim()
    // 清空再回车不是「改成空名字」，当取消处理，不发那趟必然 422 的请求。
    if (title) props.onSubmit(title)
    else props.onCancel()
  }

  return (
    <input
      class="conv-rename"
      ref={input}
      value={name()}
      onInput={(e) => setName(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') submit()
        if (e.key === 'Escape') props.onCancel()
      }}
      onBlur={() => props.onCancel()}
    />
  )
}
