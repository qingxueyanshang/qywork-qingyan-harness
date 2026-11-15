import { createEffect, onCleanup, onMount, Show } from 'solid-js'
import { absPath, isDesktopShell, revealFile, revealWorkspace } from '../../lib/store/index.ts'
import type { FileNode } from './FileTree.tsx'

/**
 * 右键菜单。**独立的浮层，不复用项目行菜单的选择器**（B8）：
 * 两个浮层共用同一条样式规则时，删除其中一个会使另一个的定位、边框与投影一并丢失。
 *
 * 位置固定在指针处（`position: fixed`），并向内收缩，避免靠近窗口右下边缘时被裁切。
 *
 * 只列出**实际可用**的项，不提供剪切 / 复制 / 粘贴：文件级剪贴板
 * 需要一套待粘贴条目的状态，没有该状态时这三项点击后没有任何效果（B5）。
 * 「在资源管理器中显示」只在桌面外壳中提供，其他端不渲染该项。
 */
export function TreeMenu(props: {
  node: FileNode
  x: number
  y: number
  onClose: () => void
  onError: (message: string) => void
  onRename: () => void
  onDelete: () => void
}) {
  createEffect(() => {
    /*
     * 只在点击菜单**外部**时关闭。
     *
     * 不能无条件关闭：`pointerdown` 先于 `click` 触发，菜单项的 click 尚未执行时，
     * 菜单就已从 DOM 中移除，导致所有菜单项都无法点击。
     */
    const onDown = (e: Event) => {
      if (!(e.target as HTMLElement | null)?.closest?.('.tree-menu')) props.onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    onCleanup(() => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    })
  })

  const abs = () => absPath(props.node.path)
  const run = (fn: () => void) => {
    fn()
    props.onClose()
  }

  /*
   * 在靠近窗口右下边缘处右键时，将菜单移回窗口内。
   *
   * **先测量再定位，不使用估算值**：菜单高度随项数变化（桌面端多一项），固定的
   * 常量会与实际项数不一致。`onMount` 在插入 DOM 之后、当前帧绘制之前执行，
   * 因此定位时不会闪烁。
   */
  let el!: HTMLDivElement
  onMount(() => {
    const box = el.getBoundingClientRect()
    const x = Math.min(props.x - 4, window.innerWidth - box.width - 8)
    const y = Math.min(props.y - 4, window.innerHeight - box.height - 8)
    el.style.left = `${Math.max(8, x)}px`
    el.style.top = `${Math.max(8, y)}px`
  })

  return (
    <div
      class="tree-menu"
      role="menu"
      ref={el}
      style={{ left: `${Math.max(8, props.x - 4)}px`, top: `${Math.max(8, props.y - 4)}px` }}
    >
      <Show when={isDesktopShell()}>
        <button
          class="tree-menu-item"
          type="button"
          role="menuitem"
          onClick={() =>
            run(() => {
              // 文件必须保留完整路径交给系统选中；目录则打开自身。
              const reveal = props.node.kind === 'dir' ? revealWorkspace : revealFile
              void reveal(abs()).catch((err) =>
                props.onError(err instanceof Error ? err.message : String(err)),
              )
            })
          }
        >
          在资源管理器中显示
        </button>
      </Show>
      <button
        class="tree-menu-item"
        type="button"
        role="menuitem"
        onClick={() => run(() => void navigator.clipboard?.writeText(abs()))}
      >
        复制路径
      </button>
      <button
        class="tree-menu-item"
        type="button"
        role="menuitem"
        onClick={() => run(() => void navigator.clipboard?.writeText(props.node.path))}
      >
        复制相对路径
      </button>
      <div class="tree-menu-sep" />
      <button
        class="tree-menu-item"
        type="button"
        role="menuitem"
        onClick={() => run(props.onRename)}
      >
        重命名
      </button>
      <button
        class="tree-menu-item danger"
        type="button"
        role="menuitem"
        onClick={() => run(props.onDelete)}
      >
        删除
      </button>
    </div>
  )
}
