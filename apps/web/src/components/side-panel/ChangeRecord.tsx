import { type FileChange, type FoldedFileChange, foldFileChanges } from '@qywork/core'
import {
  createEffect,
  createMemo,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
} from 'solid-js'
import { MAP_CODEC, SET_CODEC, sessionSignal } from '../../lib/session.ts'
import { clamp, diffFrom, firstString } from '../../lib/step-view.ts'
import {
  absPath,
  type ChangesView,
  type ChangeTurn,
  loadConversationChanges,
  loadOlderConversationChanges,
  state,
  view,
} from '../../lib/store/index.ts'
import { IconChevron, IconSpinner } from '../Icons.tsx'
import { treeIndent } from './FileTree.tsx'

/**
 * 对单个文件的**一次**改动。
 *
 * `body` 是该次改动的正文，完全取自该步骤落库的入参，与会话流中展开该步骤时显示的
 * 是同一份数据（`transcript/tools/StepBody.tsx` 的 `StepBody`）：编辑提供 old/new 两段，
 * 完整写入提供写入的全部内容。
 */
interface ChangeEdit {
  tool: string
  /** 执行者：子 agent 或外部 CLI 节点的名称；本会话自身执行时为 null。 */
  via: string | null
  changeType: FileChange['changeType']
  /** 缺省表示行数未知：shell 与外部 CLI 的写入由观察器判定，无法取得改动前的内容。 */
  additions?: number
  deletions?: number
  body: { removed: string; added: string } | { written: string } | null
}

/**
 * 该步骤的正文。**按入参结构识别，不按工具名识别**（同 `step-view.ts` 的 `diffFrom`）。
 *
 * 三种结构互不冲突：完整写入的入参中没有 old/new，编辑的入参中没有 content，
 * shell 的入参只有 command，其正文即执行的命令。
 * 不要为完整写入构造增删对比：旧内容只在工具执行时存在，从未写入数据库。
 */
function bodyOf(args: Record<string, unknown> | undefined): ChangeEdit['body'] {
  if (!args) return null
  const diff = diffFrom(args)
  if (diff) return diff
  const written = firstString(args, 'content', 'text', 'command')
  return written ? { written: clamp(written) } : null
}

/** 一轮中对单个文件的改动汇总。净效果字段由 `foldFileChanges` 提供，此处只补充每次改动的明细。 */
interface ChangedFile extends FoldedFileChange {
  /** 每次改动，按时间顺序排列。**同一个文件修改十次即记录十条。** */
  edits: ChangeEdit[]
}

/**
 * 将一轮的写入按路径折叠为文件行。
 *
 * **折叠规则位于 `foldFileChanges`（`@qywork/core`），不在此处**：表头的合计由服务端
 * 对每一轮调用同一函数算出，两处分别实现折叠必然不一致：被丢弃的行会从行列表中消失，
 * 却仍计入表头。此处只按相同顺序把每次改动关联到折叠后的行。
 */
function foldTurn(turn: ChangeTurn): ChangedFile[] {
  const flat: FileChange[] = []
  const edits = new Map<string, ChangeEdit[]>()
  for (const step of turn.steps) {
    for (const c of step.fileChanges) {
      flat.push(c)
      // 该步骤的入参已在账本中，正文取自入参，不另行保存。
      const edit: ChangeEdit = {
        tool: step.toolName,
        via: step.via?.name ?? null,
        changeType: c.changeType,
        ...(c.additions === undefined ? {} : { additions: c.additions }),
        ...(c.deletions === undefined ? {} : { deletions: c.deletions }),
        body: bodyOf(step.args),
      }
      const known = edits.get(c.path)
      if (known) known.push(edit)
      else edits.set(c.path, [edit])
    }
  }
  return foldFileChanges(flat).map((f) => ({ ...f, edits: edits.get(f.path) ?? [] }))
}

/**
 * 当前会话修改过的文件，按轮次分组。**不使用 git。**
 *
 * 真源是 step 账本：写类工具的回执带有 `fileChanges`（修改的路径，以及可取得时的增删行数）。
 * 服务端按「写入过文件的轮次」投影并分页（`/changes`），运行期间的回执直接追加到同一份数据
 * （`store/views/changes.ts` 的 `appendChange`）。**不从会话流折叠**：会话流只加载最后几轮，在长会话中由它折叠出的
 * 记录不完整，表头数值也会随之出错。
 *
 * 不使用 git 不是因为无法取得，而是因为 git 回答的是另一个问题：工作区相对 HEAD
 * 的差异中混有用户在编辑器中的修改、其他会话的修改以及全部未跟踪的
 * 文件。本页只回答当前会话做了哪些修改。两个问题放在同一面板中会形成两本账。
 *
 * 口径：
 * - **每轮一节**，最新在上且默认展开，更早的轮次收起，只显示节标题。节标题是用户的消息。
 * - 节内每个文件一行，行上的数值是该轮对该文件的改动量；展开后显示每次改动。
 * - 表头数值是整个会话的合计，由服务端计算，不是已加载分页之和；它与行使用同一个折叠
 *   函数（`foldFileChanges`），因此新建后又删除的文件在两处同时剔除。
 * - 没有 `fileChanges` 的调用不计入：读取操作，以及写入失败的文件工具。
 * - 文件类工具给出精确行数；`run_command` 与外部 CLI 的写入由观察器判定，只有变更类型，
 *   没有行数。
 */
export function ChangeRecord() {
  const conversationId = () => state.activeConversation
  const changes = () => view().changes
  createEffect(
    on(conversationId, (id) => {
      if (id) void loadConversationChanges(id)
    }),
  )
  const retry = () => {
    const id = conversationId()
    if (id) void loadConversationChanges(id)
  }

  return (
    <Switch>
      <Match when={changes()?.turns.length === 0 && changes()?.error}>
        {(error) => (
          <div class="change-more" role="alert">
            <span>历史记录加载失败：{error()}</span>
            <button class="btn-ghost sm" type="button" onClick={retry}>
              重试
            </button>
          </div>
        )}
      </Match>
      {/* 没有任何记录时整页留空：空状态不写引导文案。 */}
      <Match when={changes()?.turns.length ? changes() : null}>
        {(loaded) => (
          <div class="change-panel">
            <div class="change-head">
              <span>变更 {loaded().totals.paths.length} 个文件</span>
              <span class="change-delta">
                <span class="add">+{loaded().totals.additions}</span>
                <span class="del">−{loaded().totals.deletions}</span>
              </span>
            </div>
            <ChangeList changes={loaded()} conversationId={conversationId()} />
          </div>
        )}
      </Match>
    </Switch>
  )
}

/**
 * 轮次清单。独立为组件，使哨兵观察器与该子树的生命周期一致：
 * 面板留空时组件不存在，观察器也不存在。
 */
function ChangeList(props: { changes: ChangesView; conversationId: string | null }) {
  /**
   * 用户明确展开或收起过的轮次。没有记录的按默认状态：最新一轮展开，其余收起。
   * 记录明确的状态值而不是切换标记：新一轮到达后，原先的第一轮移到第二位，
   * 未点击过时按默认收起，点击过时保持用户设定的状态。
   */
  const [explicit, setExplicit] = sessionSignal<ReadonlyMap<string, boolean>>(
    'qywork.changes.turns',
    new Map(),
    MAP_CODEC,
  )
  const turnOpen = (turnId: string, index: number) => explicit().get(turnId) ?? index === 0
  const toggleTurn = (turnId: string, index: number) =>
    setExplicit((cur) => new Map(cur).set(turnId, !turnOpen(turnId, index)))

  /** 已展开的文件，键为「轮次 + 路径」：同一文件在不同轮次中分别展开或收起。 */
  const [openFiles, setOpenFiles] = sessionSignal<ReadonlySet<string>>(
    'qywork.changes.files',
    new Set(),
    SET_CODEC,
  )
  const fileKey = (turnId: string, path: string) => `${turnId}\n${path}`
  const toggleFile = (key: string) =>
    setOpenFiles((cur) => {
      const next = new Set(cur)
      if (!next.delete(key)) next.add(key)
      return next
    })

  let list!: HTMLUListElement
  let sentinel!: HTMLLIElement
  const loadOlder = async () => {
    if (!props.conversationId) return false
    return loadOlderConversationChanges(props.conversationId)
  }
  onMount(() => {
    const io = new IntersectionObserver(
      async (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return
        if (!(await loadOlder())) return
        // 一页加载完成后哨兵可能仍在视口中，观察器不会再次通知：重新观察一次以取得初始通知。
        io.unobserve(sentinel)
        io.observe(sentinel)
      },
      { root: list },
    )
    io.observe(sentinel)
    onCleanup(() => io.disconnect())
  })

  return (
    <ul class="tree tree-top" ref={list}>
      {/* 净效果为空的轮次不显示节标题：`foldTurn` 已丢弃这些轮次的全部行，展开后也没有内容。 */}
      <For each={props.changes.turns.filter((t) => foldTurn(t).length > 0)}>
        {(turn, index) => {
          const files = createMemo(() => foldTurn(turn))
          const additions = () => files().reduce((n, f) => n + f.additions, 0)
          const deletions = () => files().reduce((n, f) => n + f.deletions, 0)
          const open = () => turnOpen(turn.userMessageId, index())
          return (
            <li>
              {/* 行与文件树使用同一套类名与缩进（`treeIndent`）：轮次是第 0 层，文件是第 1 层。
                  不另行定义对齐数值：两份数值会逐渐不一致。 */}
              <button
                class="tree-item change-turn"
                type="button"
                style={{ 'padding-left': '2px' }}
                aria-expanded={open()}
                onClick={() => toggleTurn(turn.userMessageId, index())}
              >
                <span class="tree-chevron-slot" aria-hidden="true">
                  <IconChevron size={11} dir={open() ? 'down' : 'right'} />
                </span>
                <span class="truncate">{turn.text}</span>
                <span class="change-count">{files().length} 个文件</span>
                <Show when={files().some((f) => f.counted)}>
                  <span class="change-delta">
                    <span class="add">+{additions()}</span>
                    <span class="del">−{deletions()}</span>
                  </span>
                </Show>
              </button>
              <Show when={open()}>
                <ul class="tree tree-terminal change-files">
                  <For each={files()}>
                    {(r) => {
                      const key = fileKey(turn.userMessageId, r.path)
                      const fileOpen = () => openFiles().has(key)
                      return (
                        <li>
                          {/* 点击一行即展开该文件的每次改动，已展开的行高亮（与文件树的选中样式相同）。
                              **不实现为「打开文件」**：文件正文在「文件」页，本页回答的是
                              该轮对文件做了哪些修改。 */}
                          <button
                            class="tree-item change-row"
                            classList={{ selected: fileOpen() }}
                            type="button"
                            style={{ 'padding-left': `${treeIndent(1)}px` }}
                            aria-expanded={fileOpen()}
                            data-tip={nativePath(r.path)}
                            onClick={() => toggleFile(key)}
                          >
                            {/* 该行是可展开的节点，图标位显示折叠符号，与文件树的目录行相同。 */}
                            <span class="tree-chevron-slot" aria-hidden="true">
                              <IconChevron size={11} dir={fileOpen() ? 'down' : 'right'} />
                            </span>
                            {/* 行上显示工作区相对路径，路径较短，末尾截断时仍能保留文件名；绝对路径在悬停提示中。 */}
                            <span class="truncate">{r.path}</span>
                            {/* 改动次数只在多次修改时显示：只修改一次的文件标注「1 次」没有信息量。 */}
                            <Show when={r.edits.length > 1}>
                              <span class="change-times">{r.edits.length} 次</span>
                            </Show>
                            {/* 没有行数时只显示变更类型：删除的行数为 0/0，观察器判定的写入
                                没有行数，显示为 +0 −0 会被理解为没有任何修改。 */}
                            <Show
                              when={r.counted && r.changeType !== 'deleted'}
                              fallback={<span class="change-kind">{kindLabel(r.changeType)}</span>}
                            >
                              <span class="change-delta">
                                <span class="add">+{r.additions}</span>
                                <span class="del">−{r.deletions}</span>
                              </span>
                            </Show>
                          </button>
                          <Show when={fileOpen()}>
                            <ol class="change-edits">
                              <For each={r.edits}>
                                {(e, i) => (
                                  <li class="change-edit">
                                    <div class="edit-head">
                                      <span class="edit-no">#{i() + 1}</span>
                                      <span class="edit-tool">
                                        {e.via ? `${e.via} · ` : ''}
                                        {editLabel(e.tool)}
                                      </span>
                                      <Show
                                        when={
                                          e.additions !== undefined && e.changeType !== 'deleted'
                                        }
                                        fallback={
                                          <span class="change-kind">{kindLabel(e.changeType)}</span>
                                        }
                                      >
                                        <span class="change-delta">
                                          <span class="add">+{e.additions}</span>
                                          <span class="del">−{e.deletions}</span>
                                        </span>
                                      </Show>
                                    </div>
                                    <Switch>
                                      <Match when={e.body && 'written' in e.body ? e.body : null}>
                                        {(w) => <pre class="change-body">{w().written}</pre>}
                                      </Match>
                                      <Match when={e.body && 'removed' in e.body ? e.body : null}>
                                        {(d) => (
                                          <pre class="change-body">
                                            <Show when={d().removed}>
                                              <span class="del">{d().removed}</span>
                                            </Show>
                                            <Show when={d().added}>
                                              <span class="add">{d().added}</span>
                                            </Show>
                                          </pre>
                                        )}
                                      </Match>
                                    </Switch>
                                  </li>
                                )}
                              </For>
                            </ol>
                          </Show>
                        </li>
                      )
                    }}
                  </For>
                </ul>
              </Show>
            </li>
          )
        }}
      </For>
      {/* 清单末尾用于加载下一页：加载中与失败各占一行；没有更多记录时留空，仅作为观察器的哨兵。 */}
      <li class="change-more" ref={sentinel}>
        <Switch>
          <Match when={props.changes.loading === 'older'}>
            <IconSpinner size={13} />
            正在加载更早记录…
          </Match>
          <Match when={props.changes.error}>
            {(error) => (
              <>
                <span role="alert">历史记录加载失败：{error()}</span>
                <button class="btn-ghost sm" type="button" onClick={() => void loadOlder()}>
                  重试
                </button>
              </>
            )}
          </Match>
        </Switch>
      </li>
    </ul>
  )
}

/**
 * 该次改动使用的操作。
 *
 * 无法识别的工具名原样显示：写类工具可以增加（插件也可提供），
 * 回退为「编辑」会把整份覆盖显示为局部修改。
 */
function editLabel(tool: string): string {
  if (tool === 'edit_file') return '编辑'
  if (tool === 'write_file') return '完整写入'
  if (tool === 'write_memory') return '记忆'
  if (tool === 'delete_memory') return '删除记忆'
  if (tool === 'move_memory') return '移动记忆'
  if (tool === 'run_command') return '运行命令'
  if (tool === 'cli') return 'CLI'
  return tool
}

function kindLabel(kind: FileChange['changeType']): string {
  if (kind === 'created') return '新建'
  if (kind === 'deleted') return '已删除'
  if (kind === 'renamed') return '重命名'
  return '已修改'
}

/**
 * 将账本中的路径转换为本机绝对路径。
 *
 * **账本中也有本身就是绝对路径的条目**：写入工作区之外时（`full` 模式、
 * 额外目录），`displayPath` 返回绝对路径。不识别这种情况会拼接出
 * `C:\项目\C:\别处\x.ts`。
 */
function nativePath(p: string): string {
  return /^([A-Za-z]:[\\/]|[\\/])/.test(p) ? p : absPath(p)
}
