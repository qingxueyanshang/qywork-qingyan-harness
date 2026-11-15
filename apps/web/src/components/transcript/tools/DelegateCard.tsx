import type { SubagentKind } from '@qywork/core'
import { SUBAGENT_KIND_LABEL, SUBAGENT_NODE_ID } from '@qywork/core'
import { createMemo, createSignal, For, Index, onCleanup, Show } from 'solid-js'
import { delegateGraph, firstLine, type GraphNode } from '../../../lib/step-view.ts'
import type { TranscriptItem } from '../../../lib/store/index.ts'
import { openCliTab, openConversationTab } from '../../../lib/store/ui.ts'
import {
  layoutWorkflowGraph,
  mergeWorkflowEdgeSegments,
  routeWorkflowWires,
  type WorkflowEdgeSegment,
  type WorkflowNodeRect,
  type WorkflowWirePlan,
  workflowLayerStyle,
  workflowRailWidth,
} from '../../../lib/workflow-layout.ts'

/**
 * 任务派发的图卡片。派发单个任务与派发工作流图共用该卡片：单个任务即只有一个节点的图，
 * 两种渲染方式并存会使同一类操作在会话流中呈现两种样式。
 *
 * 结构取自参数，状态只有一个来源。参数随 `tool.started` 到达，因此第一帧即可渲染
 * 完整的图，等待执行的节点也显示在图中；状态是 `item.nodes`（工作流图折叠为 `workflow.states`），
 * 流式输出期间由 `team.member` 逐个节点替换，刷新后从 step payload 整体恢复。
 *
 * 按依赖分层排列：同一层的节点并排（它们并行执行），层与层之间用竖线连接。
 * 这已表达全部依赖关系，不绘制箭头：节点较多时，箭头会使连线难以分辨。
 */
export function DelegateCard(props: { item: TranscriptItem }) {
  /**
   * 图的结构只由 `toolName` 与 `args` 决定，一次派发中两者不变。不要写成
   * `() => delegateGraph(props.item)`：折叠后的 workflow 条目随每个进度事件重新生成，
   * `props.item` 每次都是新对象，图随之重新计算，每个节点按钮的 DOM 被替换，连线重新测量。
   */
  const shape = createMemo(
    () => ({ toolName: props.item.toolName, args: props.item.args }),
    undefined,
    { equals: (a, b) => a.toolName === b.toolName && a.args === b.args },
  )
  const graph = createMemo(() => delegateGraph(shape()))

  /**
   * 节点的当前状态。会话端点没有状态，它代表当前会话本身；检查点节点的状态由审查记录决定。
   * agent 节点只读取 `nodes`：工作流图读取折叠后的 `workflow.states`，单个任务读取该 step 自身的状态。
   */
  const stateOf = (n: GraphNode): NodeView | null => {
    if (n.kind === 'session') {
      const checkpoint = props.item.workflow?.nodes.find(
        (node) => node.kind === 'checkpoint' && node.id === n.key,
      )
      if (!checkpoint || checkpoint.kind !== 'checkpoint') return null
      const approved = props.item.workflow?.approvals[n.key]
      // `checkpointId` 只在上游全部到达终态且未批准时有值，它标识等待父会话审查的节点。
      const current = props.item.workflow?.checkpointId === n.key
      const states = props.item.workflow?.states ?? {}
      const upstreamRunning = checkpoint.needs.some((id) => {
        const phase = states[id]?.phase
        return phase === 'working' || phase === 'queued' || phase === 'waiting'
      })
      return {
        phase: approved
          ? 'done'
          : current
            ? 'waiting_review'
            : upstreamRunning
              ? 'working'
              : 'waiting',
        label: checkpoint.label,
      }
    }
    const state = props.item.workflow
      ? props.item.workflow.states[n.key]
      : props.item.nodes?.[n.key]
    return {
      phase: state?.phase ?? 'waiting',
      label: state?.label ?? '',
      ...(state?.kind ? { kind: state.kind } : {}),
      ...(state?.durationMs ? { durationMs: state.durationMs } : {}),
      ...(state?.subagentId ? { conversationId: state.subagentId } : {}),
    }
  }

  /**
   * 各层的列数与连线分配。列数不变时保持同一引用：分配只由图的结构与各层列数决定，
   * 图宽每变化一个像素都重新生成时，拖动面板期间各层的样式被反复改写。
   */
  const [width, setWidth] = createSignal(0)
  const planned = createMemo<{ graph: ReturnType<typeof delegateGraph>; plan: WorkflowWirePlan }>(
    (prev) => {
      const g = graph()
      const next = layoutWorkflowGraph(g.layers, width())
      const same =
        prev?.graph === g &&
        prev.plan.layers.every((layer, i) => layer.cols === next.layers[i]!.cols)
      return same ? prev : { graph: g, plan: next }
    },
  )
  const plan = () => planned().plan

  /**
   * 位置只能通过测量取得：节点宽度随名称与耗时变化，无法计算。测量时机由
   * `ResizeObserver` 决定：它在布局之后、绘制之前回调，因此连线与节点在同一帧完成渲染，
   * 不会先显示错位的图再修正。连线是绝对定位的 SVG，不参与布局，
   * 因此测量后绘制不会再次触发布局（不构成观察循环）。
   *
   * 绘制时用 `<Index>` 按位置复用 `<path>`：每次测量都生成新数组，`<For>` 会替换
   * 全部节点，虚线动画随之从头开始；进度事件较多时连线持续闪动。
   */
  const [segments, setSegments] = createSignal<
    (Omit<WorkflowEdgeSegment, 'live'> & { node: GraphNode })[]
  >([])
  const edges = createMemo(() =>
    mergeWorkflowEdgeSegments(
      segments().map(({ node, ...segment }) => ({
        ...segment,
        live: stateOf(node)?.phase === 'working',
      })),
    ),
  )
  let box!: HTMLDivElement
  const refs = new Map<string, HTMLElement>()

  const measure = (): number[] | undefined => {
    if (!box) return undefined
    const b = box.getBoundingClientRect()
    // 偏移半像素：1px 的描边绘制在整数坐标上会跨越两个物理像素，显示为两条颜色减半的线。
    const at = (v: number) => Math.round(v) + 0.5
    const g = graph()
    if (g.horizontal) {
      const measured: (Omit<WorkflowEdgeSegment, 'live'> & { node: GraphNode })[] = []
      for (const n of g.nodes) {
        const to = refs.get(n.key)
        const from = n.needs[0] ? refs.get(n.needs[0]) : undefined
        if (!to || !from) continue
        // 三个节点横向排列时，每条边只连接一对节点：从左侧节点右边缘中点到右侧节点左边缘中点的直线。
        const t = to.getBoundingClientRect()
        const r = from.getBoundingClientRect()
        measured.push({
          axis: 'horizontal',
          fixed: at(t.top + t.height / 2 - b.top),
          from: at(r.right - b.left),
          to: at(t.left - b.left),
          node: n,
        })
      }
      setSegments(measured)
      return undefined
    }
    const rects = new Map<string, WorkflowNodeRect>()
    const nodes = new Map<string, GraphNode>()
    for (const n of g.nodes) {
      const el = refs.get(n.key)
      if (!el) continue
      const r = el.getBoundingClientRect()
      nodes.set(n.key, n)
      rects.set(n.key, {
        left: r.left - b.left,
        right: r.right - b.left,
        top: r.top - b.top,
        bottom: r.bottom - b.top,
      })
    }
    const routed = routeWorkflowWires(plan(), rects, b.width)
    setSegments(
      routed.segments.map(({ target, ...segment }) => ({ ...segment, node: nodes.get(target)! })),
    )
    setOverflow(routed.overflow)
    return routed.lanes
  }

  /**
   * 各层上方空白中的横线数，决定该空白的高度。它由连线的横坐标决定，只能在测量后取得；
   * 写入后节点下移而横坐标不变，因此第二次测量给出相同的结果。
   */
  const [lanes, setLanes] = createSignal<number[]>([], {
    equals: (a, b) => a.length === b.length && a.every((v, i) => v === b[i]),
  })
  /** 连线越出图右边界的宽度。连线层按它加宽，卡片随之横向滚动；图本身的宽度不变，不触发重新排列。 */
  const [overflow, setOverflow] = createSignal(0)
  // 先更新图宽再测量：行数变化后节点位置随之改变，连线须使用换行后的坐标。
  // 横线数变化时在同一次回调中重新测量：节点只是移动、尺寸不变，不会再次触发观察。
  const ro = new ResizeObserver(() => {
    if (box) setWidth(box.getBoundingClientRect().width)
    const next = measure()
    if (!next) return
    const before = lanes()
    setLanes(next)
    if (lanes() !== before) measure()
  })
  onCleanup(() => ro.disconnect())
  // 几何位置只在排版完成后测量；执行状态直接更新连线样式，不触发同步布局。

  /**
   * 容器本身也需要观察。拖动面板时节点随等宽列一同缩放，容器与节点的观察结果
   * 共同触发重新计算，使连线始终使用当前帧的实际坐标。
   */
  const holdBox = (el: HTMLDivElement) => {
    box = el
    ro.observe(el)
  }

  const hold = (id: string) => (el: HTMLElement) => {
    refs.set(id, el)
    ro.observe(el)
  }

  return (
    <div
      class="wf-card"
      classList={{
        failed: props.item.workflow
          ? props.item.workflow.phase === 'failed'
          : props.item.status === 'failure',
      }}
    >
      {/* 只有工作流图有整体目标；单个任务的指令显示在其节点的第二行。 */}
      <Show when={props.item.toolName === 'workflow'}>
        <div class="wf-goal truncate">{cardTitle(props.item)}</div>
      </Show>
      {/*
        向执行中的子 agent 追加的指令不开始新的执行，服务端不为它写入节点状态；派出新任务时状态先于调用返回写入。
        因此调用成功而节点没有状态即为一次补充，标题说明这一点。判据取自已落盘的字段，历史中的卡片同样适用。
      */}
      <Show
        when={
          props.item.toolName === 'subagent' &&
          props.item.status === 'success' &&
          !props.item.nodes?.[SUBAGENT_NODE_ID]
        }
      >
        <div class="wf-goal truncate">补充说明</div>
      </Show>
      <div
        class="wf-graph"
        classList={{ across: graph().horizontal }}
        style={{ 'padding-right': `${workflowRailWidth(plan().rails)}px` }}
        ref={holdBox}
      >
        <svg
          class="wf-edges"
          aria-hidden="true"
          style={overflow() ? { width: `calc(100% + ${overflow()}px)` } : undefined}
        >
          <Index each={edges()}>{(e) => <path d={e().d} classList={{ live: e().live }} />}</Index>
        </svg>
        <For each={graph().layers}>
          {(nodes, layer) => (
            <div
              class="wf-layer"
              classList={{ wrapped: plan().layers[layer()]?.wrapped === true }}
              style={
                graph().horizontal
                  ? undefined
                  : workflowLayerStyle(plan().layers[layer()]!, lanes()[layer()] ?? 0)
              }
            >
              <For each={nodes}>
                {(n) => {
                  const st = () => stateOf(n)
                  /*
                   * 点击节点即打开其内容。两种节点打开的内容不同：内置子 agent 打开对应的
                   * 子会话；外部 CLI 是本机的另一个进程，打开的是它的输出流。
                   * 两者都不存在时（尚未执行）无法打开。
                   *
                   * 种类只依据状态判定。继续派发时调用参数只有一个子 agent id，据此推测种类会把
                   * 外部 CLI 误判为内置子 agent，打开的是一条没有正文的子会话。
                   */
                  const cli = () => st()?.kind === 'cli'
                  // 第一行显示节点名称。单个任务没有节点 id，节点名称即执行者，
                  // 因此运行期间取得更完整的名称（厂商 + CLI 名称）时使用该名称。
                  const name = () => st()?.label || n.title
                  const open = () => {
                    const cid = st()?.conversationId
                    if (cli()) openCliTab(props.item.id, n.key, name())
                    else if (cid) openConversationTab(cid, name())
                  }
                  return (
                    <Show
                      when={n.kind === 'agent'}
                      fallback={
                        // 两端节点代表当前会话本身，分别表示派发与收回。不可点击：它就是用户正在查看的页面。
                        <div
                          class="wf-node session"
                          classList={{ [st()?.phase ?? 'waiting']: true }}
                          ref={hold(n.key)}
                        >
                          <span class="wf-node-name truncate">{n.title}</span>
                        </div>
                      }
                    >
                      <button
                        type="button"
                        class="wf-node"
                        classList={{ [st()?.phase ?? 'waiting']: true }}
                        disabled={cli() ? st()?.phase === 'waiting' : !st()?.conversationId}
                        onClick={open}
                        ref={hold(n.key)}
                      >
                        {/* 第一行显示节点名称与种类，第二行显示指令与耗时；两种卡片使用同一规则。 */}
                        <span class="wf-node-head">
                          <span class="wf-node-name">{name()}</span>
                          <Show when={st()?.kind}>
                            {(kind) => (
                              <span class="wf-node-kind">{SUBAGENT_KIND_LABEL[kind()]}</span>
                            )}
                          </Show>
                        </span>
                        <span class="wf-node-who">
                          <Show when={n.task}>
                            <span class="wf-node-task">{n.task}</span>
                          </Show>
                          <Show when={st()?.durationMs}>
                            {(ms) => <span class="wf-node-time">{(ms() / 1000).toFixed(1)}s</span>}
                          </Show>
                        </span>
                      </button>
                    </Show>
                  )
                }}
              </For>
            </div>
          )}
        </For>
      </div>
      {/* 失败原因只显示在此处：边框已表示失败，这一行说明原因。 */}
      <Show
        when={
          (props.item.workflow
            ? props.item.workflow.phase === 'failed'
            : props.item.status === 'failure') && props.item.outcome?.message
        }
      >
        {(msg) => <div class="wf-error">{msg()}</div>}
      </Show>
    </div>
  )
}

/** 节点的显示状态：agent 节点取自 `NodeState`，检查点节点取自审查记录。 */
interface NodeView {
  phase: string
  label: string
  /** 派发给哪一种子 agent；检查点节点与尚无状态的节点没有该字段。 */
  kind?: SubagentKind
  durationMs?: number
  conversationId?: string
}

/** 卡片顶部一行：本次派发的整体目标，取 `args.goal` 的第一行。 */
function cardTitle(item: TranscriptItem): string {
  const raw = item.args?.goal
  return firstLine(typeof raw === 'string' ? raw.trim() : '')
}
