import { createSignal, onCleanup, Show } from 'solid-js'
import {
  activateWorkspace,
  archiveWorkspaceChats,
  isDesktopShell,
  type KnownWorkspace,
  pinKnownWorkspace,
  removeKnownWorkspace,
  revealWorkspace,
} from '../lib/store/index.ts'
import { AnchoredMenu } from './AnchoredMenu.tsx'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import {
  IconArchive,
  IconFolder,
  IconFolderOpen,
  IconMore,
  IconNewChat,
  IconPin,
  IconX,
} from './Icons.tsx'

/**
 * 项目行：文件夹图标 + 名称 + `⋯` 菜单（当前项目另有「新建会话」）。
 *
 * **菜单为内联实现，未抽取为通用 Menu 组件。** 只有本组件与 `ConversationRow` 使用此类菜单，且菜单项完全不同。
 * 为此创建带定位、受控开合、键盘导航的通用组件，会使后续每次改动都多经过一层间接调用（B2）。出现第三个调用点时再抽取。
 *
 * **每一项都必须产生可观察的变化。** 「在资源管理器中打开」只有桌面外壳具备该能力，浏览器和手机端
 * **不渲染该项**，而不是渲染后点击报错（B5）。「移除」对当前项目同样显示：服务端会指定接下来切换到哪个
 * 项目，只有它是最后一个项目时才返回 409，此时拒绝理由由服务端给出，比隐藏按钮更清楚。
 *
 * **两个破坏性操作都需要确认。** 移除和归档都不删除数据，但都会使条目从界面上消失，而恢复方式并不
 * 直观：移除后需重新添加同一路径，归档后在界面上无法恢复（这是用户明确要求的语义）。因此确认文字中完整写明边界（B7）。
 */
export function ProjectRow(props: {
  workspace: KnownWorkspace
  /** 当前正在使用的项目；移除后会自动切换到服务端指定的下一个项目。 */
  current?: boolean
  /** 当前项目的会话列表是否展开。 */
  expanded?: boolean
  onOpen?: () => void
  onNewChat?: () => void
  /** 列表或会话有变动时重新获取：顺序、计数、会话列表都可能已经变化。 */
  onChanged?: () => void
  onError?: (message: string) => void
}) {
  const [menuOpen, setMenuOpen] = createSignal(false)
  /** 等待确认的操作。null 表示没有。同一时刻最多一个。 */
  const [armed, setArmed] = createSignal<'remove' | 'archive' | null>(null)

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
   * **按本行的容器判定，不使用类选择器**：`closest('.project-menu-wrap')` 对其他项目行
   * 同样成立，点击另一行的 `⋯` 时本行的菜单不会关闭，两张卡片重叠。
   *
   * **确认弹窗打开时一律不处理**：弹窗渲染在 `.project-menu-wrap` 之外，
   * 按下「移除项目」时的 mousedown 会先命中此处并清除 `armed`，
   * 弹窗随之卸载，click 不会触发，按钮点击后没有响应。
   * 弹窗自身有遮罩和 Esc，打开期间由弹窗负责关闭。
   */
  const onDocDown = (e: MouseEvent) => {
    if (armed() !== null) return
    const t = e.target as Node | null
    if (!t || !wrapEl?.contains(t)) close()
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close()
  }
  /*
   * 卡片使用 fixed 定位，坐标只在展开时计算一次：列表滚动或窗口尺寸改变后它会停留在
   * 原位置，与对应行错位，因此收起菜单，由用户重新打开。确认弹窗显示时不收起：此时菜单在
   * 弹窗后方。scroll 不冒泡，容器内的滚动只能在捕获阶段接收。
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

  /**
   * 确认之后实际执行的操作。
   *
   * 移除的正是当前项目时，服务端会在 `next` 中指定切换目标，**此处立即切换**。
   * 不切换时客户端持有的 `?ws=` 指向一个已不在列表中的项目，随后每个请求都返回 404。
   */
  const confirmed = async () => {
    if (armed() === 'archive') return archiveWorkspaceChats(props.workspace.id)
    const res = await removeKnownWorkspace(props.workspace.id)
    if (props.current && res.next) await activateWorkspace({ path: res.next.rootPath })
    return res
  }

  /** 所有菜单操作都经由此处：统一收起菜单、统一显示失败，不静默丢弃。 */
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn()
      close()
      props.onChanged?.()
    } catch (e) {
      close()
      props.onError?.(e instanceof Error ? e.message : String(e))
    }
  }

  const pinned = () => props.workspace.pinnedAt !== undefined

  return (
    <div class="project-head">
      <button
        class="project-open"
        type="button"
        onClick={() => props.onOpen?.()}
        aria-expanded={props.current ? Boolean(props.expanded) : false}
        aria-label={
          props.current
            ? `${props.workspace.name}，${props.expanded ? '收起会话' : '展开会话'}`
            : `${props.workspace.name}，切换项目`
        }
      >
        <Show when={pinned()} fallback={<IconFolder size={15} />}>
          {/* 置顶的项目替换图标，而不是在名称后添加「已置顶」标签：
              标签会挤占本已不足的名称宽度。 */}
          <IconPin size={15} class="pinned-mark" />
        </Show>
        <span class="project-name truncate">{props.workspace.name}</span>
      </button>

      {/* 始终显示，不在悬停时才显示：手机端没有 hover，悬停才显示的按钮在手机端无法使用。 */}
      <Show when={props.current}>
        <button
          class="icon-btn project-new"
          type="button"
          aria-label="新建对话"
          data-tip="在此项目中新建对话"
          onClick={() => props.onNewChat?.()}
        >
          <IconNewChat size={14} />
        </button>
      </Show>

      <div
        class="project-menu-wrap"
        ref={(el) => {
          wrapEl = el
        }}
      >
        <button
          class="icon-btn project-more"
          ref={moreEl}
          type="button"
          aria-label={`${props.workspace.name} 的更多操作`}
          aria-expanded={menuOpen()}
          onClick={() => {
            setMenuOpen(!menuOpen())
            setArmed(null)
          }}
        >
          <IconMore size={14} />
        </button>

        <Show when={menuOpen()}>
          <AnchoredMenu class="project-menu" anchor={moreEl}>
            <button
              class="menu-item"
              type="button"
              role="menuitem"
              onClick={() => void run(() => pinKnownWorkspace(props.workspace.id, !pinned()))}
            >
              <IconPin size={14} />
              {pinned() ? '取消置顶' : '置顶项目'}
            </button>

            {/* 只有桌面外壳能调用系统文件管理器。 */}
            <Show when={isDesktopShell()}>
              <button
                class="menu-item"
                type="button"
                role="menuitem"
                onClick={() => void run(() => revealWorkspace(props.workspace.rootPath))}
              >
                <IconFolderOpen size={14} />
                在资源管理器中打开
              </button>
            </Show>

            <button
              class="menu-item"
              type="button"
              role="menuitem"
              onClick={() => setArmed('archive')}
            >
              <IconArchive size={14} />
              归档聊天
            </button>

            {/* 当前项目也能移除，服务端会指定接下来切换到哪个项目。只有最后一个项目才返回 409，
                  该情况下此处仍显示按钮：拒绝理由由服务端给出，比隐藏按钮更清楚。 */}
            <button
              class="menu-item danger"
              type="button"
              role="menuitem"
              onClick={() => setArmed('remove')}
            >
              <IconX size={14} />
              移除
            </button>
          </AnchoredMenu>
        </Show>
      </div>

      {/* 确认使用弹窗，不在列表中就地展开：232px 宽的侧栏无法容纳一句带边界声明的文字。 */}
      <ConfirmDialog
        open={armed() !== null}
        title={armed() === 'remove' ? `移除 ${props.workspace.name}？` : '归档现有会话？'}
        message={
          armed() === 'remove'
            ? '仅从列表中移除，不改动本机文件。'
            : '现有会话将不再显示，数据不会删除。'
        }
        confirmLabel={armed() === 'remove' ? '移除项目' : '归档'}
        danger={armed() === 'remove'}
        onConfirm={() => void run(confirmed)}
        onCancel={() => setArmed(null)}
      />
    </div>
  )
}
