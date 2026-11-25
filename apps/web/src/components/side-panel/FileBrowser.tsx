import {
  createEffect,
  createResource,
  createSignal,
  lazy,
  on,
  onCleanup,
  onMount,
  Show,
} from 'solid-js'
import { createRefreshKey, loaded, suspendUntil } from '../../lib/resource.ts'
import { SET_CODEC, sessionSignal } from '../../lib/session.ts'
import {
  client,
  explainApiError,
  fileRevealRequest,
  forgetViewing,
  openFile,
  openFileInPanel,
  setFileRevealRequest,
  setOpenFile,
  state,
  workspace,
} from '../../lib/store/index.ts'
import { ConfirmDialog } from '../ConfirmDialog.tsx'
import { HoldSwitch } from '../HoldSwitch.tsx'
import {
  IconChevron,
  IconCollapseAll,
  IconFilePlus,
  IconFolderPlus,
  IconRefresh,
  IconX,
} from '../Icons.tsx'
import { type FileNode, SearchHits, Tree, type TreeCtx } from './FileTree.tsx'
import { TreeMenu } from './TreeMenu.tsx'

/**
 * 懒加载：它包含 CodeMirror 核心（约 300 kB），只查看待办与变更的用户不需要加载它。
 * 文件页与文件预览页必须共用这一个包装：另行声明的包装首次渲染时，即使模块已加载也会挂起一次。
 */
const FileView = lazy(() => import('../FileView.tsx'))

/**
 * 文件预览页：与文件页中的预览相同，按文件失效序号重新读取（合并连续失效，同 `FileBrowser`）。
 * 不传 `onClose`：该页由页签上的 × 关闭。
 */
export function FileTab(props: { path: string }) {
  const refreshKey = createRefreshKey(
    () => (state.connection === 'ready' ? workspace()?.id : undefined),
    () => state.fileVersion,
  )
  return <FileView path={props.path} refresh={refreshKey().revision} />
}

const parentDir = (path: string) => path.split('/').slice(0, -1).join('/')

export function FileBrowser() {
  const refreshKey = createRefreshKey(
    () => (state.connection === 'ready' ? workspace()?.id : undefined),
    () => state.fileVersion,
  )
  const treeSource = () => {
    const { scope, revision } = refreshKey()
    return scope ? `${scope}:${revision}` : (false as const)
  }
  const [tree, { refetch }] = createResource(
    // 连接未就绪时不发送必然失败的请求；恢复为 ready 后同一资源自动重新获取。
    // fileVersion 同时覆盖精确文件工具与只能粗粒度失效的命令/子流程。
    treeSource,
    () => client.api<{ nodes: FileNode[] }>('/api/files/tree?depth=2'),
  )
  suspendUntil(() => !tree.loading)

  /**
   * 文件树获取失败时显示的错误信息。
   *
   * **不要改为 `tree()` 或 `tree.latest`**：两者在出错时都会 `throw`，而本应用
   * 没有 `ErrorBoundary`，抛出的错误无人处理。`loaded()` 只返回值，错误从 `tree.error` 单独读取。
   */
  const treeError = () => (tree.error ? explainApiError(tree.error, '读取失败') : null)

  // 展开的目录、选中的行、搜索词与根目录展开按项目记录，刷新后恢复；展开的目录在挂载后按需重新获取。
  const ws = workspace()?.id ?? ''
  const [expanded, setExpanded] = sessionSignal<ReadonlySet<string>>(
    `qywork.files.expanded:${ws}`,
    new Set(),
    SET_CODEC,
  )
  const [kids, setKids] = createSignal<ReadonlyMap<string, FileNode[]>>(new Map())
  /** 选中的行。它同时决定新建的位置，因此文件与目录都会记录。记录时不含子层。 */
  const [selected, setSelected] = sessionSignal<Pick<FileNode, 'path' | 'kind'> | null>(
    `qywork.files.selected:${ws}`,
    null,
    {
      save: (node) => (node ? { path: node.path, kind: node.kind } : null),
      load: (raw) => raw as Pick<FileNode, 'path' | 'kind'> | null,
    },
  )
  const [creating, setCreating] = createSignal<{ kind: 'file' | 'dir'; dir: string } | null>(null)
  const [renaming, setRenaming] = createSignal<FileNode | null>(null)
  const [nameError, setNameError] = createSignal<string | null>(null)
  const [menuAt, setMenuAt] = createSignal<{ node: FileNode; x: number; y: number } | null>(null)
  /** 文件树上一次操作（展开、删除、在资源管理器中显示）的失败原因，显示在文件树顶部。 */
  const [actionError, setActionError] = createSignal<string | null>(null)
  const [doomed, setDoomed] = createSignal<FileNode | null>(null)
  const [query, setQuery] = sessionSignal(`qywork.files.query:${ws}`, '')
  const [rootOpen, setRootOpen] = sessionSignal(`qywork.files.root:${ws}`, true)
  /**
   * 手动刷新作用于整个文件页，不只是左侧文件树。
   *
   * 当前文件预览有独立的 resource；只调用文件树的 `refetch()` 时，右侧正文仍显示旧内容，
   * 刷新看起来没有响应。该递增值只表示一次刷新命令，不另存任何文件状态。
   */
  const [manualRefresh, setManualRefresh] = createSignal(0)

  let browser!: HTMLDivElement
  onMount(() => {
    // 点击空白、预览或会话区时取消行选择；树内操作仍使用当前选择确定目标。
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || !(e.target instanceof Element)) return
      if (
        browser.contains(e.target) &&
        e.target.closest('.tree-item, .tree-root-acts, .tree-search, .tree-edit, .tree-menu')
      )
        return
      setSelected(null)
    }
    window.addEventListener('pointerdown', onDown, true)
    onCleanup(() => window.removeEventListener('pointerdown', onDown, true))
  })

  // 打开文件时同步选中并展开祖先目录；后续点击目录仍由 selected 决定高亮。
  createEffect(
    on(fileRevealRequest, (request) => {
      if (!request || request.workspaceId !== ws) return
      setSelected({ path: request.path, kind: 'file' })
      setQuery('')
      setRootOpen(true)
      setExpanded((current) => {
        const next = new Set(current)
        const parts = request.path.split('/')
        for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join('/'))
        return next
      })
      setFileRevealRequest(null)
    }),
  )

  /*
   * 根树重新获取时，展开目录的懒加载缓存必须同时失效。只重新获取根节点时，已展开的目录
   * 仍优先显示 `kids` 中的旧内容，根目录已更新而子层不变。
   */
  createEffect<string | false>((previous) => {
    const current = treeSource()
    if (current && current !== previous) setKids(new Map())
    return current
  }, false)

  // 子目录懒加载：大仓库中一次性获取整棵树需要数秒（文件树不过滤，`node_modules`
  // 也包含在内），而用户通常只展开一两层。
  const loadDir = (path: string) => {
    void client
      .api<{ nodes: FileNode[] }>(`/api/files/tree?path=${encodeURIComponent(path)}&depth=1`)
      .then((res) => setKids((m) => new Map(m).set(path, res.nodes)))
      .catch((err) => {
        // 收起该节点：保持展开而内容为空时，无法区分空目录与读取失败。再次展开即重新请求。
        setExpanded((s) => {
          const next = new Set(s)
          next.delete(path)
          return next
        })
        setActionError(`无法展开 ${path}：${explainApiError(err, '读取失败')}`)
      })
  }

  /**
   * 新建 / 重命名 / 删除之后，所在层必须**立即重新获取并覆盖缓存**。
   *
   * 不能只从缓存中删除再等待自动重新获取：`TreeNode` 未找到缓存时会回退到根请求
   * `depth=2` 返回的 `node.children`，那份数据已过期；删除缓存后文件树不变，
   * 新建看起来没有生效。根层没有上一级可获取，使用 `refetch()`。
   */
  const invalidate = (dir: string) => {
    if (!dir) {
      void refetch()
      return
    }
    setExpanded((s) => new Set(s).add(dir))
    loadDir(dir)
  }

  const ctx: TreeCtx = {
    expanded,
    childrenOf: (path) => kids().get(path) ?? null,
    /*
     * 高亮的行**只由 `selected` 决定**。
     *
     * 不要把主区打开的文件（`openFile`）也纳入判定：两个权威同时决定同一处高亮时，
     * 点击文件夹不会高亮（高亮停留在已打开的文件上），点击文件后选中状态看起来没有保留。
     * 最后点击的行即选中行；点击空白或树外区域时取消选中，已打开的预览保持不变。
     */
    selected: () => renaming()?.path ?? selected()?.path ?? null,
    load: loadDir,
    toggle: (node) => {
      setSelected(node)
      setExpanded((s) => {
        const next = new Set(s)
        if (!next.delete(node.path)) next.add(node.path)
        return next
      })
    },
    pick: (node) => {
      setSelected(node)
      openFileInPanel(node.path)
    },
    menu: (node, x, y) => {
      setSelected(node)
      setActionError(null)
      setMenuAt({ node, x, y })
    },
    creating,
    renaming: () => renaming()?.path ?? null,
    nameError,
    cancelName: () => {
      setCreating(null)
      setRenaming(null)
      setNameError(null)
    },
    submitName: (raw) => {
      const name = raw.trim()
      if (!name) return
      const job = renaming()
      const make = creating()
      void (async () => {
        try {
          if (job) {
            const { node } = await client.api<{ node: FileNode }>('/api/files/rename', {
              method: 'POST',
              body: JSON.stringify({ path: job.path, name }),
            })
            setRenaming(null)
            setNameError(null)
            invalidate(parentDir(node.path))
            setSelected(node)
            // 重命名的是主区已打开的文件时，同步切换到新路径，否则主区指向一个已不存在的路径。
            if (openFile() === job.path && node.kind === 'file') openFileInPanel(node.path)
          } else if (make) {
            const path = make.dir ? `${make.dir}/${name}` : name
            const { node } = await client.api<{ node: FileNode }>('/api/files/create', {
              method: 'POST',
              body: JSON.stringify({ path, kind: make.kind }),
            })
            setCreating(null)
            setNameError(null)
            invalidate(make.dir)
            setSelected(node)
            if (node.kind === 'file') openFileInPanel(node.path)
          }
        } catch (err) {
          // `ApiError` 的消息是服务端返回的错误描述（「x 已存在」），不含状态码与路径。
          setNameError(err instanceof Error ? err.message : String(err))
        }
      })()
    },
  }

  /** 新建位置：选中目录时在该目录中；选中文件时在其所在目录；未选中时在根目录。 */
  const newIn = (kind: 'file' | 'dir') => {
    const s = selected()
    const dir = !s ? '' : s.kind === 'dir' ? s.path : parentDir(s.path)
    setRenaming(null)
    setNameError(null)
    setCreating({ kind, dir })
    // 新建行位于该目录下，须先展开目录，否则输入框处于折叠的层中。
    if (dir) setExpanded((s2) => new Set(s2).add(dir))
    setRootOpen(true)
  }

  const remove = (node: FileNode) => {
    void client
      .api('/api/files/delete', { method: 'POST', body: JSON.stringify({ path: node.path }) })
      .then(() => {
        invalidate(parentDir(node.path))
        if (openFile() === node.path) setOpenFile(null)
        if (selected()?.path === node.path) setSelected(null)
      })
      .catch((err) => setActionError(`无法删除 ${node.path}：${explainApiError(err, '删除失败')}`))
      .finally(() => setDoomed(null))
  }

  return (
    /*
     * **文件树在左、文件内容在右**，位于同一面板中。
     *
     * 文件树不占满面板：它是索引，宽度固定；正文是阅读区域，占据其余全部宽度。
     * 面板宽度由用户拖动左边沿调整（`.panel-grip`）：两栏并排时必须支持调整，
     * 否则内容栏只有一百余像素。
     */
    <div class="file-browser" ref={browser}>
      <div class="file-tree-col">
        {/* 搜索位于第一行：它是文件树的入口，不应排在文件树操作之后。 */}
        <input
          class="tree-search"
          type="search"
          placeholder="搜索名称"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />

        {/* 根目录行：只负责展开与四个操作按钮，不参与文件选中；hover 样式由整行承担，
            标题按钮自身不另加灰色背景。理由见 `panel.css` 的 `.tree-root`。 */}
        <div class="tree-root">
          <button
            class="tree-item tree-root-name"
            type="button"
            onClick={() => {
              // 根目录行是结构标题，不是可选节点。清空选择后，后续新建仍位于根目录。
              setSelected(null)
              setRootOpen((v) => !v)
            }}
          >
            <span class="tree-chevron-slot" aria-hidden="true">
              <IconChevron size={11} dir={rootOpen() ? 'down' : 'right'} />
            </span>
            <span class="truncate">{workspace()?.name ?? '工作区'}</span>
          </button>
          <div class="tree-root-acts">
            <button
              class="icon-btn"
              type="button"
              aria-label="新建文件"
              data-tip="新建文件"
              onClick={() => newIn('file')}
            >
              <IconFilePlus size={14} />
            </button>
            <button
              class="icon-btn"
              type="button"
              aria-label="新建文件夹"
              data-tip="新建文件夹"
              onClick={() => newIn('dir')}
            >
              <IconFolderPlus size={14} />
            </button>
            <button
              class="icon-btn"
              type="button"
              aria-label="刷新"
              data-tip="刷新"
              aria-busy={tree.loading}
              onClick={() => {
                // 清空子层缓存但**保留展开状态**：清空展开状态时，每次刷新都会使整棵树全部折叠。
                setKids(new Map())
                setManualRefresh((n) => n + 1)
                void refetch()
              }}
            >
              {/*
               * 每次点击固定旋转一圈，不与 `tree.loading` 的时长绑定：本机请求常在
               * 浏览器首次绘制前就已结束，只按 loading 显示动画时用户无法看到任何一帧。
               * transform 的终点持续递增，连续点击时从上一圈继续旋转，无需计时器。
               */}
              <IconRefresh
                size={14}
                style={{
                  transform: `rotate(${manualRefresh() * 360}deg)`,
                  transition: 'transform 360ms ease-out',
                }}
              />
            </button>
            <button
              class="icon-btn"
              type="button"
              aria-label="全部折叠"
              data-tip="全部折叠"
              onClick={() => setExpanded(new Set())}
            >
              <IconCollapseAll size={14} />
            </button>
          </div>
        </div>

        {/* 获取失败时显示原因并提供重试按钮。
            静默显示空树时，用户无法判断项目为何没有任何文件。 */}
        <Show when={treeError()}>
          {(msg) => (
            <div class="tree-hint">
              {msg()}
              <button class="btn-ghost sm" type="button" onClick={() => void refetch()}>
                重试
              </button>
            </div>
          )}
        </Show>

        <Show when={actionError()}>
          {(msg) => (
            <div class="tree-hint" role="alert">
              {msg()}
              <button
                class="icon-btn"
                type="button"
                aria-label="关闭错误提示"
                onClick={() => setActionError(null)}
              >
                <IconX size={12} />
              </button>
            </div>
          )}
        </Show>

        <Show
          when={query().trim()}
          fallback={
            <Show when={rootOpen()}>
              <Tree ctx={ctx} dir="" nodes={loaded(tree)?.nodes ?? []} depth={1} />
            </Show>
          }
        >
          {(q) => <SearchHits ctx={ctx} query={q()} />}
        </Show>
      </div>

      {/*
       * **按路径重新挂载**（`HoldSwitch` 以路径为键）：点击另一个文件时，上一个文件保留到新文件的代码与预览
       * 读取完成，再在同一次更新中替换，超过 `SLOW_MS` 时显示新文件的加载态。
       * 不要改为同一个 `FileView` 随路径重新读取：重新获取期间 `loaded()` 返回上一个文件的结果，
       * 上一个文件的错误、源码切换与缩放都会带到新文件。刷新同一个文件时不重新挂载，阅读位置保留。
       */}
      <HoldSwitch key={openFile()}>
        {(path) => (
          <Show when={path}>
            {(p) => (
              <FileView
                path={p()}
                refresh={manualRefresh() + refreshKey().revision}
                onClose={() => {
                  setOpenFile(null)
                  forgetViewing(p())
                }}
              />
            )}
          </Show>
        )}
      </HoldSwitch>

      <Show when={menuAt()}>
        {(at) => (
          <TreeMenu
            node={at().node}
            x={at().x}
            y={at().y}
            onClose={() => setMenuAt(null)}
            onError={(msg) => setActionError(`无法打开目录：${msg}`)}
            onRename={() => {
              setCreating(null)
              setNameError(null)
              setRenaming(at().node)
            }}
            onDelete={() => setDoomed(at().node)}
          />
        )}
      </Show>

      <ConfirmDialog
        open={doomed() !== null}
        title={doomed()?.kind === 'dir' ? '删除文件夹' : '删除文件'}
        message={
          doomed()?.kind === 'dir'
            ? `${doomed()?.path} 及其中的全部内容将一并删除，且删除后无法恢复。`
            : `${doomed()?.path} 删除后无法恢复。`
        }
        confirmLabel="删除"
        danger
        onConfirm={() => {
          const node = doomed()
          if (node) remove(node)
        }}
        onCancel={() => setDoomed(null)}
      />
    </div>
  )
}
