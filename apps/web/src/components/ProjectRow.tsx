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
 * 一行项目：文件夹图标 + 名字 + `⋯` 菜单（+ 当前项目还有「新建会话」）。
 *
 * **菜单是内联的，没有抽成通用 Menu 组件。** 全项目只有这一处用得上它。为一次使用造一个带定位、受控
 * 开合、键盘导航的通用组件，是在给后面每一个改动加一层间接（B2）。真出现第二个调用点时再抽。
 *
 * **每一项都必须产生可观察的变化。** 「在资源管理器中打开」只有桌面外壳有这个能力，浏览器和手机端**
 * 不渲染这一项**，而不是渲染出来点了报错（B5）。「移除」对当前项目也画——服务端会指好接下来切哪
 * 个，只有它是最后一个时才回 409，那时拒绝的理由由服务端说，比「按钮没了」清楚。
 *
 * **两个破坏性动作都要确认。** 移除和归档都不删数据，但都会让条目从界面上消失，而「怎么让它回来」不
 * 是自明的：移除靠重新添加同一路径，归档在界面上则根本回不来（这是用户点名要的语义）。所以确认句里把边界写全（B7）。
 */
export function ProjectRow(props: {
  workspace: KnownWorkspace
  /** 当前正在用的那个：它展开会话列表，移除之后会自动切到服务端指定的下一个。 */
  current?: boolean
  onOpen?: () => void
  onNewChat?: () => void
  /** 列表或会话有变动时重拉——顺序、计数、会话列表都可能已经不一样了。 */
  onChanged?: () => void
  onError?: (message: string) => void
}) {
  const [menuOpen, setMenuOpen] = createSignal(false)
  /** 正在等确认的动作。null = 没有。同时只可能有一个。 */
  const [armed, setArmed] = createSignal<'remove' | 'archive' | null>(null)

  const close = () => {
    setMenuOpen(false)
    setArmed(null)
  }

  /** 菜单卡片钉在这颗 `⋯` 上，收起判断也按这一行的容器算。 */
  let wrapEl: HTMLDivElement | undefined
  let moreEl!: HTMLButtonElement

  /*
   * 点到本行之外就收起菜单。捕获阶段监听，否则会被内部的 stopPropagation 拦住。
   *
   * **按本行的容器判，不用类选择器**：`closest('.project-menu-wrap')` 对别的项目行
   * 同样成立，点另一行的 `⋯` 时这一行的菜单不关，两张卡片叠在一起。
   *
   * **确认弹窗立着的时候一律不管**：弹窗渲染在 `.project-menu-wrap` 之外，
   * 按下「移除项目」的那一下 mousedown 会先命中这里、把 `armed` 清掉，
   * 弹窗随之卸载，click 根本轮不到——按钮看起来点了没反应。
   * 弹窗自己有遮罩和 Esc，它开着时由它负责关。
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
   * 卡片是 fixed 的，坐标只在展开那一刻算一次——列表滚动或窗口改尺寸之后它会停在
   * 原地，与那一行脱节，所以收起来让用户重开。确认弹窗立着时不动它：那时菜单在
   * 弹窗后面。scroll 不冒泡，容器内的滚动只有捕获阶段收得到。
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
   * 确认之后真正执行的那一下。
   *
   * 移除的正是当前项目时，服务端会在 `next` 里指好去处——**立刻切过去**。
   * 不切的话客户端手里的 `?ws=` 指着一个已经不在列表里的项目，随后每条请求都 404。
   */
  const confirmed = async () => {
    if (armed() === 'archive') return archiveWorkspaceChats(props.workspace.id)
    const res = await removeKnownWorkspace(props.workspace.id)
    if (props.current && res.next) await activateWorkspace(res.next.rootPath)
    return res
  }

  /** 每个菜单动作都走这里：统一收起菜单、统一把失败说出来，不静默吞掉。 */
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
        disabled={props.current}
      >
        <Show when={pinned()} fallback={<IconFolder size={15} />}>
          {/* 置顶的项目换图标，而不是在名字后面加一个「已置顶」标签：
              标签会挤掉本来就不够用的名字宽度。 */}
          <IconPin size={15} class="pinned-mark" />
        </Show>
        <span class="project-name truncate">{props.workspace.name}</span>
      </button>

      {/* 常显而不是悬停才出现：手机端没有 hover，藏起来等于没有。 */}
      <Show when={props.current}>
        <button
          class="icon-btn project-new"
          type="button"
          aria-label="新建对话"
          data-tip="在这个项目里新建对话"
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

            {/* 只有桌面外壳够得着系统文件管理器。 */}
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

            {/* 当前项目也能移除——服务端会指好接下来切哪个。只有最后一个才回 409，
                  那种情况下这里照样画按钮：拒绝的理由由服务端说，说得比「按钮没了」清楚。 */}
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

      {/* 确认是弹窗，不在列表里就地展开——232px 的栏放不下一句带边界声明的话。 */}
      <ConfirmDialog
        open={armed() !== null}
        title={armed() === 'remove' ? `移除 ${props.workspace.name}？` : '归档现有会话？'}
        message={
          armed() === 'remove' ? '只从列表里移除，本机文件不动。' : '现有会话不再显示，数据不删。'
        }
        confirmLabel={armed() === 'remove' ? '移除项目' : '归档'}
        danger={armed() === 'remove'}
        onConfirm={() => void run(confirmed)}
        onCancel={() => setArmed(null)}
      />
    </div>
  )
}
