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
 * ## 菜单是内联的，没有抽成通用 Menu 组件
 *
 * 全项目只有这一处用得上它。为一次使用造一个带定位、受控开合、键盘导航的
 * 通用组件，是在给后面每一个改动加一层间接（B2）。真出现第二个调用点时再抽。
 *
 * ## 每一项都必须产生可观察的变化
 *
 * 「在资源管理器中打开」只有桌面外壳有这个能力，浏览器和手机端**不渲染这一项**，
 * 而不是渲染出来点了报错（B5）。「移除」对当前项目也画——服务端会指好接下来切哪个，
 * 只有它是最后一个时才回 409，那时拒绝的理由由服务端说，比「按钮没了」清楚。
 *
 * ## 两个破坏性动作都要确认
 *
 * 移除和归档都不删数据，但都会让东西从界面上消失，而「怎么让它回来」不是自明的：
 * 移除靠重新添加同一路径，归档在界面上则根本回不来（这是用户点名要的语义，
 * 见 `docs/plans/2026-08-12-项目行重做.md` 批 7）。所以确认句里把边界写全（B7）。
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
  const [card, setCard] = createSignal(false)
  /** 正在等确认的动作。null = 没有。同时只可能有一个。 */
  const [armed, setArmed] = createSignal<'remove' | 'archive' | null>(null)

  const close = () => {
    setMenuOpen(false)
    setArmed(null)
  }

  /*
   * 点到别处就收起菜单。捕获阶段监听，免得被内部的 stopPropagation 吃掉。
   *
   * **确认弹窗立着的时候一律不管**：弹窗渲染在 `.project-menu-wrap` 之外，
   * 按下「移除项目」的那一下 mousedown 会先命中这里、把 `armed` 清掉，
   * 弹窗随之卸载，click 根本轮不到——按钮看起来点了没反应。
   * 弹窗自己有遮罩和 Esc，它开着时由它负责关。
   */
  const onDocDown = (e: MouseEvent) => {
    if (armed() !== null) return
    if (!(e.target as HTMLElement | null)?.closest?.('.project-menu-wrap')) close()
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close()
  }
  document.addEventListener('mousedown', onDocDown, true)
  document.addEventListener('keydown', onKey)
  onCleanup(() => {
    document.removeEventListener('mousedown', onDocDown, true)
    document.removeEventListener('keydown', onKey)
  })

  /**
   * 确认之后真正执行的那一下。
   *
   * 移除的如果正是脚下这块地板，服务端会在 `next` 里指好去处——**立刻切过去**。
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
      {/* 卡片的 hover 挂在这个按钮上，不挂外层 div：
          给静态元素加交互处理器过不了 a11y 这一闸，而给它补一个 role 只是把
          规则绕过去——真正的交互元素本来就是这个按钮。 */}
      <button
        class="project-open"
        type="button"
        onClick={() => props.onOpen?.()}
        disabled={props.current}
        onMouseEnter={() => setCard(true)}
        onMouseLeave={() => setCard(false)}
        onFocus={() => setCard(true)}
        onBlur={() => setCard(false)}
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
          title="在这个项目里新建对话"
          onClick={() => props.onNewChat?.()}
        >
          <IconNewChat size={14} />
        </button>
      </Show>

      <div class="project-menu-wrap">
        <button
          class="icon-btn project-more"
          type="button"
          aria-label={`${props.workspace.name} 的更多操作`}
          aria-expanded={menuOpen()}
          onClick={() => {
            setCard(false)
            setMenuOpen(!menuOpen())
            setArmed(null)
          }}
        >
          <IconMore size={14} />
        </button>

        {/* 悬浮卡片：名字 / 会话数 / 完整路径。菜单开着时不出现，两个浮层不叠。 */}
        <Show when={card() && !menuOpen()}>
          <div class="project-card">
            <div class="project-card-name truncate">{props.workspace.name}</div>
            <div class="project-card-meta">{props.workspace.conversations} 个会话</div>
            <div class="project-card-path">{props.workspace.rootPath}</div>
          </div>
        </Show>

        <Show when={menuOpen()}>
          <div class="project-menu" role="menu">
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
          </div>
        </Show>
      </div>

      {/* 确认是弹窗，不在列表里就地展开——232px 的栏放不下一句带边界声明的话。 */}
      <ConfirmDialog
        open={armed() !== null}
        title={armed() === 'remove' ? `移除 ${props.workspace.name}？` : '归档现有会话？'}
        message={
          armed() === 'remove'
            ? '这会把项目从列表里移除。你电脑上的文件和已有的聊天记录都不会被删除，重新添加同一个文件夹就会回来。'
            : '这个项目现有的会话不再显示在列表里。数据不会被删除，之后新建的会话照常显示。'
        }
        confirmLabel={armed() === 'remove' ? '移除项目' : '归档'}
        danger={armed() === 'remove'}
        onConfirm={() => void run(confirmed)}
        onCancel={() => setArmed(null)}
      />
    </div>
  )
}
