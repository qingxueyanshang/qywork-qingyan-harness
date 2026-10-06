import type { Conversation } from '@qywork/core'
import { createSignal, onCleanup, onMount, Show } from 'solid-js'
import { archiveConversation, deleteConversation, renameConversation } from '../lib/store/index.ts'
import { AnchoredMenu } from './AnchoredMenu.tsx'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { IconArchive, IconMore, IconPencil, IconTrash } from './Icons.tsx'

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * 侧栏行中的时间：今天显示时刻，昨天显示「昨天」，更早显示日期。
 *
 * **不写「N 分钟前」**：相对时间需要定时重新渲染，否则渲染后即过期。
 * 按当日零点分界，不按「相差 24 小时」：凌晨一点的消息当晚应显示为「昨天」。
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
 * 整行是 button，`⋯` 也是 button，**两个 button 不能嵌套**（浏览器会把内层移出，
 * 点击区域随之错位），因此外层只能是 div。
 *
 * 菜单与 `ProjectRow` 的菜单分别实现：菜单项完全不同，抽取通用组件需要先出现第三个调用点（B2）；
 * `.conv-menu` 的样式同样自带完整规则，不与 `.project-menu` 共用选择器（B8）。
 */
export function ConversationRow(props: {
  conversation: Conversation
  active: boolean
  /** 该会话正在运行。列表中每一条都能判定，判据是 `state.busyConversations`。 */
  running: boolean
  onOpen: () => void
  onError?: (message: string) => void
}) {
  const [menuOpen, setMenuOpen] = createSignal(false)
  const [renaming, setRenaming] = createSignal(false)
  /** 等待确认的操作。null 表示没有。同一时刻最多一个。 */
  const [armed, setArmed] = createSignal<'archive' | 'delete' | null>(null)

  const close = () => {
    setMenuOpen(false)
    setArmed(null)
  }

  /** 菜单卡片固定在本行的 `⋯` 按钮上，收起判断也以本行的容器为准。 */
  let wrapEl: HTMLDivElement | undefined
  let moreEl!: HTMLButtonElement

  /*
   * 点击本行之外时收起菜单。在捕获阶段监听，否则会被内部的 stopPropagation 拦截。
   *
   * **按本行的容器判定，不使用类选择器**：`closest('.conv-menu-wrap')` 对其他会话行
   * 同样成立，点击另一行的 `⋯` 时本行的菜单不会关闭，两张卡片重叠。
   *
   * **确认弹窗打开时一律不处理**：弹窗渲染在 `.conv-menu-wrap` 之外，确认按钮的
   * mousedown 会先命中此处并清除 `armed`，弹窗随之卸载，click 不再触发。
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
   * 卡片使用 fixed 定位，坐标只在展开时计算一次：列表滚动或窗口尺寸改变后它会停留在
   * 原位置，与对应行错位，因此收起菜单，由用户重新打开。确认弹窗显示时不收起：此时菜单在
   * 弹窗后方，收起会连同弹窗的来源一并移除。
   * scroll 不冒泡，容器内的滚动只能在捕获阶段接收。
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

  /** 所有操作都经由此处：统一收起菜单、统一显示失败，不静默丢弃。 */
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
              {/* `aria-hidden`：它与会话流中的读数条重复，屏幕阅读器已播报过该信息。 */}
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
                    <IconTrash size={14} />
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

      {/* 确认使用弹窗，不在行内就地展开：232px 宽的侧栏无法容纳。 */}
      <ConfirmDialog
        open={armed() !== null}
        title={armed() === 'delete' ? '删除会话？' : '归档会话？'}
        message={armed() === 'delete' ? undefined : '归档后无法在界面中恢复。'}
        confirmLabel={armed() === 'delete' ? '删除' : '归档'}
        danger={armed() === 'delete'}
        onConfirm={() =>
          void run(async () => {
            if (armed() !== 'delete') return archiveConversation(props.conversation.id)
            // 会话已删除但空间未回收：经由 onError 显示，与删除失败显示在同一处。
            const reclaimError = await deleteConversation(props.conversation.id)
            if (reclaimError) props.onError?.(reclaimError)
          })
        }
        onCancel={() => setArmed(null)}
      />
    </div>
  )
}

/**
 * 行内重命名。
 *
 * **自行获取焦点，不使用 `autofocus`**：该属性只在文档解析时生效，而该输入框是动态插入的。
 * 随之失效的还有失焦即取消（从未获得焦点就不会失焦），输入框将无法退出。
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
    // 清空后按回车不是「改为空名称」，按取消处理，不发送必然返回 422 的请求。
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
