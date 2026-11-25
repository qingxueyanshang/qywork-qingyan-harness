import type { JSX } from 'solid-js'
import { createEffect, createResource, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { composing } from '../../lib/input/composing.ts'
import { attachLongPress, touchPrimary } from '../../lib/long-press.ts'
import { loaded } from '../../lib/resource.ts'
import { client, WORKSPACE_PATH_TYPE } from '../../lib/store/index.ts'
import FileTypeIcon from '../FileTypeIcon.tsx'
import { IconChevron, IconFolder } from '../Icons.tsx'

export interface FileNode {
  name: string
  path: string
  kind: 'file' | 'dir'
  size: number
  mtime: number
  children?: FileNode[]
}

/**
 * 文件树的共享操作。**展开状态、子层缓存与正在编辑的行都不保存在节点中**：
 * 「全部折叠」「刷新」需一次作用于所有节点，新建行需能出现在任意目录下；
 * 分散在各 `TreeNode` 的局部信号中时，没有一处能操作全部节点。
 */
export interface TreeCtx {
  expanded(): ReadonlySet<string>
  toggle(node: FileNode): void
  /** `null` 表示该层尚未取回（刷新会将其清为 `null`，已展开的目录自行重新获取）。 */
  childrenOf(path: string): FileNode[] | null
  load(path: string): void
  selected(): string | null
  pick(node: FileNode): void
  menu(node: FileNode, x: number, y: number): void
  /** 正在该目录下新建。`dir` 是工作区相对路径，根目录为空串。 */
  creating(): { kind: 'file' | 'dir'; dir: string } | null
  /** 正在重命名的路径。 */
  renaming(): string | null
  submitName(name: string): void
  cancelName(): void
  /** 上一次提交名称时返回的错误（重名等）。 */
  nameError(): string | null
}

/**
 * 第 depth 层行的左内边距。每层递进 10px：子行的层级线位于父行箭头线条的中心
 * （父内边距 + 7），子行的图标位从该线右侧 3px 起，图标线条距该线 8px。
 * 不要缩小到 6px：徽标会紧贴层级线。
 */
export const treeIndent = (depth: number): number => depth * 10 + 2

/**
 * 按名称搜索的结果，扁平列出，替代文件树显示。
 *
 * **搜索跳过依赖目录与构建产物**（服务端 `findByName`），而文件树不跳过。该边界必须
 * 显示出来，否则 `node_modules` 中的文件不在搜索结果中时，会被理解为文件不存在。
 */
export function SearchHits(props: { ctx: TreeCtx; query: string }) {
  const [debounced, setDebounced] = createSignal(props.query)
  createEffect(() => {
    const q = props.query
    const t = setTimeout(() => setDebounced(q), 300)
    onCleanup(() => clearTimeout(t))
  })

  const [hits] = createResource(debounced, (q) =>
    client.api<{ matches: FileNode[]; truncated: boolean }>(
      `/api/files/find?q=${encodeURIComponent(q)}`,
    ),
  )

  // 使用 `loaded()`：每次修改搜索词都会更换 source，`hits()` 会在两批结果之间进入 Suspense，
  // 使面板连同上方的搜索框一起移出 DOM，输入第二个字符时搜索框已不存在。
  // 重新获取期间保留上一批结果，新结果返回后再替换。
  const matches = () => loaded(hits)

  return (
    <div class="tree-hits">
      <For each={matches()?.matches ?? []}>
        {(hit) => (
          <button
            class="tree-item"
            classList={{ selected: props.ctx.selected() === hit.path }}
            type="button"
            data-tip={hit.path}
            disabled={hit.kind === 'dir'}
            ref={(el) => attachLongPress(el, (x, y) => props.ctx.menu(hit, x, y))}
            onClick={() => props.ctx.pick(hit)}
            onContextMenu={(e) => {
              e.preventDefault()
              props.ctx.menu(hit, e.clientX, e.clientY)
            }}
          >
            <Show when={hit.kind === 'dir'} fallback={<FileTypeIcon name={hit.name} />}>
              <span class="tree-node-icon" aria-hidden="true">
                <IconFolder size={13} />
              </span>
            </Show>
            <span class="truncate">{hit.path}</span>
          </button>
        )}
      </For>
      <Show when={matches() && matches()!.matches.length === 0}>
        <div class="tree-hint">没有匹配的名称。不搜索依赖目录与构建产物。</div>
      </Show>
      <Show when={matches()?.truncated}>
        <div class="tree-hint">匹配项过多，只显示前一部分。</div>
      </Show>
    </div>
  )
}

export function Tree(props: { ctx: TreeCtx; dir: string; nodes: FileNode[]; depth: number }) {
  const making = () => {
    const m = props.ctx.creating()
    return m && m.dir === props.dir ? m : null
  }

  return (
    <ul
      class="tree"
      classList={{
        'tree-top': props.depth === 1,
        'tree-terminal': props.nodes.every((node) => node.kind !== 'dir'),
      }}
      style={{ '--tree-guide-left': `${treeIndent(props.depth) - 3}px` } as JSX.CSSProperties}
    >
      {/* 新建行**位于该目录第一个子项的位置**：
          输入框出现在新条目将要创建的位置。 */}
      <Show when={making()}>
        {(m) => (
          <li>
            <NameRow
              ctx={props.ctx}
              kind={m().kind}
              depth={props.depth}
              value=""
              placeholder={m().kind === 'file' ? '文件名' : '文件夹名'}
            />
          </li>
        )}
      </Show>
      <For each={props.nodes}>
        {(node) => <TreeNode ctx={props.ctx} node={node} depth={props.depth} />}
      </For>
    </ul>
  )
}

/**
 * 就地输入名称的行。新建与重命名共用**同一结构**：相同的缩进、相同的图标位，
 * 输入框位于图标之后。分别实现会导致两者外观不一致，而对用户而言它们是同一操作。
 */
function NameRow(props: {
  ctx: TreeCtx
  kind: 'file' | 'dir'
  depth: number
  value: string
  placeholder?: string
  chevronDir?: 'right' | 'down' | undefined
}) {
  const [name, setName] = createSignal(props.value)
  /** 回车或 Esc 已处理本次输入；再次输入时清除。 */
  let settled = false

  /*
   * **主动获取焦点，不依赖 `autofocus`。**
   *
   * `autofocus` 只在文档解析时生效；该行在点击按钮后动态插入，即使带有该属性
   * 也不会获得焦点。其后果不只是无法直接输入：**下方的失焦即取消逻辑
   * 也随之失效**（从未获得焦点就不会失焦），点击别处时该行仍留在文件树中。
   *
   * 重命名时同时全选：输入框初始值为原名，用户通常需要整体替换。
   */
  let input!: HTMLInputElement
  onMount(() => {
    input.focus()
    input.select()
  })

  return (
    <div class="tree-edit" style={{ 'padding-left': `${treeIndent(props.depth)}px` }}>
      <Show when={props.chevronDir}>
        {(dir) => (
          <span class="tree-chevron-slot" aria-hidden="true">
            <IconChevron size={11} dir={dir()} />
          </span>
        )}
      </Show>
      <Show when={props.kind === 'file'}>
        <FileTypeIcon name={name()} />
      </Show>
      <Show when={props.kind === 'dir' && !props.chevronDir}>
        <span class="tree-node-icon" aria-hidden="true">
          <IconFolder size={13} />
        </span>
      </Show>
      <input
        class="tree-edit-input"
        ref={input}
        placeholder={props.placeholder}
        value={name()}
        onInput={(e) => {
          settled = false
          setName(e.currentTarget.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !composing(e)) {
            settled = true
            props.ctx.submitName(name())
          }
          if (e.key === 'Escape') {
            settled = true
            props.ctx.cancelName()
          }
        }}
        onBlur={() => {
          // 失焦即提交，名称为空时取消：手机键盘的「完成」只使输入框失焦，失焦即取消时输入的名称被丢弃。
          // 回车或 Esc 已处理时不再处理：输入框随之移除时同样会失焦。存在错误时不处理，错误信息保留在界面上供用户阅读。
          if (settled || props.ctx.nameError()) return
          if (name().trim()) props.ctx.submitName(name())
          else props.ctx.cancelName()
        }}
      />
      <Show when={props.ctx.nameError()}>
        {(msg) => <span class="tree-edit-error truncate">{msg()}</span>}
      </Show>
    </div>
  )
}

function TreeNode(props: { ctx: TreeCtx; node: FileNode; depth: number }) {
  let button: HTMLButtonElement | undefined
  const open = () => props.ctx.expanded().has(props.node.path)
  const children = () => props.ctx.childrenOf(props.node.path) ?? props.node.children ?? null
  const editing = () => props.ctx.renaming() === props.node.path

  // 已展开且该层尚未取回时发起获取。**获取的触发条件是「已展开且缺少数据」**，
  // 不是点击动作：刷新清空缓存后，已展开的目录依靠该条件自行重新获取。
  createEffect(() => {
    if (open() && children() === null) props.ctx.load(props.node.path)
  })

  createEffect(() => {
    if (props.ctx.selected() === props.node.path) {
      button?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  })

  const row = (onClick: () => void) => (
    <button
      class="tree-item"
      ref={(el) => {
        button = el
        attachLongPress(el, (x, y) => props.ctx.menu(props.node, x, y))
      }}
      data-path={props.node.path}
      aria-current={props.ctx.selected() === props.node.path ? 'true' : undefined}
      classList={{ selected: props.ctx.selected() === props.node.path }}
      type="button"
      style={{ 'padding-left': `${treeIndent(props.depth)}px` }}
      aria-expanded={props.node.kind === 'dir' ? open() : undefined}
      // 触屏不可拖动：长按可拖动的元素时浏览器开始拖放，长按菜单不会出现；触屏上也没有可放入的位置。
      draggable={props.node.kind === 'file' && !touchPrimary()}
      onDragStart={(e) => e.dataTransfer?.setData(WORKSPACE_PATH_TYPE, props.node.path)}
      onClick={onClick}
      onContextMenu={(e) => {
        e.preventDefault()
        props.ctx.menu(props.node, e.clientX, e.clientY)
      }}
    >
      <Show when={props.node.kind === 'dir'} fallback={<FileTypeIcon name={props.node.name} />}>
        <span class="tree-chevron-slot" aria-hidden="true">
          <IconChevron size={11} dir={open() ? 'down' : 'right'} />
        </span>
      </Show>
      <span class="truncate">{props.node.name}</span>
    </button>
  )

  return (
    <li>
      <Show
        when={editing()}
        fallback={
          <Show when={props.node.kind === 'dir'} fallback={row(() => props.ctx.pick(props.node))}>
            {row(() => props.ctx.toggle(props.node))}
          </Show>
        }
      >
        <NameRow
          ctx={props.ctx}
          kind={props.node.kind}
          depth={props.depth}
          value={props.node.name}
          chevronDir={props.node.kind === 'dir' ? (open() ? 'down' : 'right') : undefined}
        />
      </Show>
      <Show when={props.node.kind === 'dir' && open()}>
        <Tree
          ctx={props.ctx}
          dir={props.node.path}
          nodes={children() ?? []}
          depth={props.depth + 1}
        />
      </Show>
    </li>
  )
}
