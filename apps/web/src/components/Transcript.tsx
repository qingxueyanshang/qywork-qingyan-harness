import type { RunUsage, StopReason } from '@qywork/core'
import { formatMoney } from '@qywork/core'
import type { JSX } from 'solid-js'
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
} from 'solid-js'
import { renderMarkdown } from '../lib/markdown.ts'
import {
  actionLabel,
  buildRenderItems,
  groupTitle,
  type RenderItem,
  reconcileRenderItems,
} from '../lib/render-items.ts'
import {
  argsRows,
  clamp,
  compact,
  diffFrom,
  firstString,
  hitRate,
  listOf,
  sanitizeTarget,
  statusWord,
  stopReasonLabel,
} from '../lib/step-view.ts'
import { retryLastRun, setState, state, type TranscriptItem } from '../lib/store/index.ts'
import { IconSpinner } from './Icons.tsx'

/**
 * 会话流。
 *
 * 自动滚动只在用户本来就贴着底部时才跟随——往上翻历史时被强行拽回底部是最恼人的
 * 交互之一，而模型输出期间这会每秒发生几十次。
 */
export function Transcript() {
  let scroller!: HTMLDivElement
  const [pinned, setPinned] = createSignal(true)

  // 带对账的投影：没变的行沿用上一轮的对象，`<For>` 才不会把整列 DOM 重建掉
  // （重建的代价是展开着的折叠会自己合上，见 reconcileRenderItems）。
  const items = createMemo<RenderItem[]>((prev = []) =>
    reconcileRenderItems(prev, buildRenderItems(state.transcript)),
  )

  const onScroll = () => {
    const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
    setPinned(gap < 80)
  }

  createEffect(() => {
    const last = state.transcript[state.transcript.length - 1]
    void state.transcript.length
    void last?.text.length
    if (pinned()) queueMicrotask(() => scroller?.scrollTo({ top: scroller.scrollHeight }))
  })

  return (
    <div class="transcript" ref={scroller} onScroll={onScroll}>
      <div class="transcript-inner">
        <For each={items()}>
          {(node) => (
            <Switch>
              <Match when={node.kind === 'user'}>
                <div class="row user">
                  <div class="user-col">
                    {/* 附件在气泡**上方**：它是这句话的语境，读的顺序也该是先看图再看话。 */}
                    <Show when={(node as { item: TranscriptItem }).item.attachments?.length}>
                      <div class="attach-row sent">
                        <For each={(node as { item: TranscriptItem }).item.attachments}>
                          {(a) => (
                            <span class="attach-chip" title={a.path}>
                              <span class="truncate">{a.name}</span>
                            </span>
                          )}
                        </For>
                      </div>
                    </Show>
                    <Show when={(node as { item: TranscriptItem }).item.text}>
                      <div class="bubble">{(node as { item: TranscriptItem }).item.text}</div>
                    </Show>
                  </div>
                </div>
              </Match>
              <Match when={node.kind === 'text'}>
                <Prose item={(node as { item: TranscriptItem }).item} />
              </Match>
              <Match when={node.kind === 'thinking'}>
                <ThinkingFold item={(node as { item: TranscriptItem }).item} />
              </Match>
              <Match when={node.kind === 'tool'}>
                <ToolCard item={(node as { item: TranscriptItem }).item} />
              </Match>
              <Match when={node.kind === 'compaction'}>
                <CompactionCard item={(node as { item: TranscriptItem }).item} />
              </Match>
              <Match when={node.kind === 'run'}>
                <RunCard item={(node as { item: TranscriptItem }).item} />
              </Match>
              <Match when={node.kind === 'group'}>
                <ToolGroup members={(node as { members: TranscriptItem[] }).members} />
              </Match>
            </Switch>
          )}
        </For>

        <Show when={state.error}>
          {(e) => (
            <div class="error-card" role="alert">
              <strong>{e().message}</strong>
              {/* 错误码存在的全部意义就是决定「用户下一步该做什么」。
                  只渲染 message 等于把分类结果丢掉——同一句「请求失败」下面，
                  该去配 key 和该等一分钟是两种完全不同的处境。 */}
              <Show when={errorHint(e().code)}>{(h) => <span class="hint">{h()}</span>}</Show>
              {/* 「可以重试」必须带一个真的能点的按钮：告诉用户可以做某件事
                  却不给做的入口，比不提更让人恼火。 */}
              <Show when={e().retryable && state.lastRunId && !state.running}>
                <button class="ghost-btn" type="button" onClick={retryLastRun}>
                  重试
                </button>
              </Show>
            </div>
          )}
        </Show>

        {/* 指令被拒绝的回执。fail-closed 的 UI 落点：拒绝必须被看见。
            用 <output> 而不是 div+role="status"：隐含语义一样，少一个属性。 */}
        <Show when={state.notice}>
          {(n) => (
            <output class="notice-card">
              <span>{n().message}</span>
              <button class="ghost-btn" type="button" onClick={() => setState('notice', null)}>
                知道了
              </button>
            </output>
          )}
        </Show>

        {/* 还在跑的那一轮没有 run 行可读，挂在流尾；跑完由 `run.finished`
            落成条目，位置就在它那一轮的最后一步之后。 */}
        <Show when={state.running}>
          <LiveRunBar />
        </Show>
      </div>
    </div>
  )
}

/**
 * 这一轮此刻在**哪个阶段**。
 *
 * 四态，句式平齐：正在请求 / 正在思考 / 正在执行 / 正在回复。
 *
 * 这一格说的是阶段，不是动作。工具组头那句说的才是这一批工具在做什么
 * （查询 / 读取 / 创建 / 修改 / 删除 / 运行 / 调用），两者粒度不同、不重复——
 * 动作轴里也没有「执行」这个词，不会撞。
 *
 * 按**流的位置**判断，而不是按快照推：从时间线快照反推会慢半拍，
 * 而这行字的全部意义就是「它现在有反应」。
 *
 * ## 为什么必须有「正在请求」这一档
 *
 * 之前只有三档，「正在回复」是**兜底**。而刚发出消息那一刻，流的最后一条是用户
 * 自己那句话——于是回车之后立刻显示「正在回复…」，紧接着冒出来的却是思考内容。
 * 那句话在它为真之前就说了：请求刚发出，模型一个字都还没吐。
 *
 * 现在四档各自对应流尾的一种真实条目，兜底的是「请求已发出、还没有任何回应」
 * ——那也是唯一一种没有条目可指的状态。
 */
function liveStatus(): string {
  const last = state.transcript[state.transcript.length - 1]
  if (last?.kind === 'thinking') return '正在思考…'
  if (last?.kind === 'tool') return '正在执行…'
  if (last?.kind === 'text') return '正在回复…'
  return '正在请求…'
}

/** 流式期两次重解析之间的最小间隔。见 `Prose` 的说明。 */
const REPARSE_MS = 60

/**
 * assistant 正文。
 *
 * 只有「运行中且是最后一条」才按流式渲染（关闭语言自动检测）；定稿后重渲染一次
 * 并开启检测。这是性能取舍，见 markdown.ts 的说明。
 *
 * ## 为什么要给重解析限速
 *
 * **不是**因为 Solid 更新慢——那正好相反：一个 delta 只改一条 step 的 text 字段，
 * 只更新一个文本节点。贵的是 markdown **整篇重解析**，而它和文档长度成正比。
 *
 * 实测（`renderMarkdown`，切片覆盖到全文尾部）：
 *
 * ```
 *  1330 字   平均 0.8ms/次   尾部最慢 1.0ms
 *  5320 字   平均 3.0ms/次   尾部最慢 7.5ms
 * 15960 字   平均 15.7ms/次  尾部最慢 39.6ms   ← 一帧才 16.7ms
 * ```
 *
 * 也就是说：短回复毫无问题，**长回复的后半段每来一个 delta 就掉两帧以上**。
 * 所以限的是重解析的频率，不是状态更新的频率——文字照常按原速进 store，
 * 一个字都不会丢，只是画面每 60ms 才追一次。
 *
 * 定稿时**必须立刻用最新全文重渲染一次**：否则最后 60ms 内到达的尾巴会永远
 * 停在上一帧，用户看到的是一段被截断的回答。
 */
function Prose(props: { item: TranscriptItem }) {
  const streaming = () =>
    state.running && state.transcript[state.transcript.length - 1]?.id === props.item.id

  const [paced, setPaced] = createSignal(props.item.text)
  let timer: ReturnType<typeof setTimeout> | null = null
  onCleanup(() => {
    if (timer) clearTimeout(timer)
  })

  createEffect(() => {
    const text = props.item.text
    if (!streaming()) {
      // 定稿：清掉待跑的节流，立刻对齐到全文。
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      setPaced(text)
      return
    }
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      // 读的是**当下最新**的 text，不是排队时那一份——中间到达的 delta 一次补齐。
      setPaced(props.item.text)
    }, REPARSE_MS)
  })

  const html = createMemo(() => renderMarkdown(paced(), { streaming: streaming() }))

  return (
    <div class="row assistant" classList={{ superseded: props.item.superseded }}>
      {/* 内容经 markdown.ts 净化后才进 innerHTML —— 模型输出不可信 */}
      <div class="prose markdown" innerHTML={html()} />
    </div>
  )
}

/**
 * 折叠：思考、工具、工具组共用的**同一个**形状。
 *
 * 不要让它们长成三样（思考一个左边框、工具一张卡片、工具组另一张更大的卡片）：
 * 三种形状在同一列里交替出现，而它们在语义上是同一类东西——**这一轮里发生了
 * 一件可以展开看的事**。
 *
 * 用原生 `<details>` 而不是自己管 open 状态：键盘语义、`Enter`/`Space` 展开、
 * 屏幕阅读器的展开态播报全是白拿的，自写 button + signal 每一样都要补。
 */
function Fold(props: {
  label: string
  /** 终态字样。**成功不写字**——一屏几十行全是「成功」等于没有信息。 */
  statusWord?: string
  target?: string
  running?: boolean
  /**
   * 跟着状态自动开合：跑起来展开、跑完收起。
   *
   * **不是 `open={props.running}` 直绑。** 直绑的话用户在跑的过程中点不动它——
   * 每次重渲染都会被拉回去。这里只在**状态翻转的那一刻**写一次，
   * 中间用户自己点开或点合，以用户的为准，直到下一次翻转。
   *
   * 不给这个 prop 的折叠维持原样：默认收起、全靠手点。
   */
  autoOpen?: boolean
  /**
   * 展开之后组头**不再转圈**。
   *
   * 只给工具组用：展开后正在跑的那张卡自己在转，组头再转一个说的是同一件事，
   * 而下面那个还指明了是哪一条。收起时组头仍要转——那时组内看不见，它是唯一的信号。
   *
   * 单张工具卡不能开这个：它展开后里面是参数和输出，没有第二个转圈接手。
   */
  quietWhenOpen?: boolean
  /** 思考那类「背景信息」压暗一档，hover 时恢复。 */
  dim?: boolean
  failed?: boolean
  superseded?: boolean
  children: JSX.Element
}) {
  const [open, setOpen] = createSignal(props.autoOpen === true)
  createEffect(
    on(
      () => props.autoOpen,
      (v) => {
        if (v !== undefined) setOpen(v)
      },
    ),
  )

  return (
    <details
      class="fold"
      open={open()}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      classList={{ 'fold-dim': props.dim, failed: props.failed, superseded: props.superseded }}
    >
      {/* 一整行不换行：文本槽负责省略，右侧的箭头与转圈不收缩。 */}
      <summary class="fold-head">
        <span class="fold-summary">
          <span class="fold-label">{props.label}</span>
          <Show when={props.statusWord}>
            <span class="fold-word">{props.statusWord}</span>
          </Show>
          <Show when={props.target}>
            <span class="fold-target" title={props.target}>
              · {sanitizeTarget(props.target!)}
            </span>
          </Show>
        </span>
        <Show when={props.running && !(props.quietWhenOpen && open())}>
          <span class="fold-spin" />
        </Show>
      </summary>
      <div class="fold-body">{props.children}</div>
    </details>
  )
}

function ThinkingFold(props: { item: TranscriptItem }) {
  const streaming = () =>
    state.running && state.transcript[state.transcript.length - 1]?.id === props.item.id
  // 流仍在增长时说「思考中」，停了说「已思考」——避免出现
  // 「标签写着已思考、旁边转圈说正在思考」的自相矛盾。
  const verb = () => (streaming() ? '思考中' : '已思考')
  const preview = () => props.item.text.replace(/\s+/g, ' ').trim().slice(0, 80)

  /*
   * 思考块自己滚到底。
   *
   * `.fold-pre` 是**内层滚动容器**（max-height 200px），会话流那个「贴着底就跟随」
   * 的效果只作用在外层。于是跑着的时候它自动展开了，但停在第一屏——新来的字
   * 一直往下堆在看不见的地方，看起来像卡住了。
   *
   * 只在流式期跟随：停下来之后用户往回翻，不该被拽回底部（那正是外层刻意避免的）。
   */
  let pre: HTMLPreElement | undefined
  createEffect(() => {
    void props.item.text
    if (streaming() && pre) pre.scrollTop = pre.scrollHeight
  })

  return (
    <Fold dim autoOpen={streaming()} label={preview() ? `${verb()} — ${preview()}` : verb()}>
      <pre class="fold-pre" ref={pre}>
        {props.item.text}
      </pre>
    </Fold>
  )
}

/**
 * Run 收尾条：停止原因 + 真实用量 + 耗时。**一轮一条。**
 *
 * ## 为什么收数据靠 props 而不是读 store
 *
 * 读 `state.usage` / `state.stopReason` / `state.runStartedAt` 那几个全局字段的话，
 * 整个会话只会有一条：第二轮跑完把第一轮的读数冲掉，刷新更是一条不剩。
 * 而这些数字逐轮落在 `runs` 表里——一轮一个条目、由投影层从 run 行重建，
 * 才是它本来的形状。
 *
 * 跑完的那一轮走 `props.run`；还在跑的那一轮没有 run 行可读，
 * 由 `<LiveRunBar />` 拿实时状态渲染同一个外壳。
 *
 * 三条口径必须守住：
 * - **停止原因永远显示**，正常完成也显示（只是低调）。废除「静默 done」的意义
 *   就在于用户不用追问「它怎么停了」。
 * - **缓存命中为 null 时显示「未回报」而不是 0**：provider 没回报和真实零命中
 *   是两回事，显示成 0 会让人以为缓存配置错了。
 * - 计价为 0 时不显示金额，而不是显示 $0.0000——未知计价冒充免费更误导。
 */
function RunStatusBar(props: {
  usage: RunUsage | null
  stopReason: StopReason | null
  /** 秒。null = 没有可信的起止时刻，不显示这一格。 */
  elapsed: number | null
  running: boolean
}) {
  const normal = () => !props.stopReason || props.stopReason === 'completed'

  return (
    <div class="run-strip" classList={{ done: !props.running, abnormal: !normal() }}>
      {/* 星河条：运行时星点流动，跑完暂停动画并压暗——「还在跑」和「跑完了」
          必须在余光里就能分清，光靠文字变化做不到。 */}
      <span class="run-galaxy" aria-hidden="true" />

      <span class="run-readout">
        <Show when={props.elapsed !== null}>
          <span class="run-metric run-elapsed" title="本轮耗时">
            {props.elapsed!.toFixed(1)}s
          </span>
        </Show>
        <Show when={props.usage}>
          {(usage) => (
            <>
              <span class="run-metric" title="输入 / 输出 token">
                ↓{compact(usage().inputTokens)} ↑{compact(usage().outputTokens)}
              </span>
              {/* 口径（分母是输入总量、优先取最后一次调用、null 与 0 的区别）
                  全在 `hitRate` 上，这里不复述——两处各写一遍必然漂移。 */}
              <span class="run-metric" title="最后一次模型调用的缓存命中占输入总量的比例">
                命中 {hitRate(usage())}
              </span>
              {/* 计价为 0 时不显示金额：未知计价冒充免费更误导。 */}
              <Show when={usage().cost > 0}>
                <span class="run-metric run-cost">
                  {formatMoney(usage().cost, usage().currency)}
                </span>
              </Show>
            </>
          )}
        </Show>
        {/*
         * 「正在思考…」跟在钱后面，和停止原因同一格。
         *
         * 别把它浮在输入区上方：那里没有它的位置，出现和消失会把输入框整体推动，
         * 也就是 B9 说的「尺寸随内容变」。而这一格本来就是给「这一轮怎么样了」用的：
         * 跑着的时候说在干什么，跑完了说为什么停，同一个位置、同一种语义。
         */}
        <Show when={props.running}>
          <span class="run-live">{liveStatus()}</span>
        </Show>
        {/* 停止原因排在**末位**：它长度不定，排在最前会把后面几格读数整体右推，
            于是出错的那一轮和正常的那些轮列对不齐。放最后，前面几格的列位恒定。 */}
        <Show when={!normal()}>
          <span class="run-reason">{stopReasonLabel(props.stopReason!)}</span>
        </Show>
      </span>
    </div>
  )
}

/**
 * 还在跑的那一轮。
 *
 * 只有它需要一个每 100ms 走一格的计时器，所以单独一层：**跑完的那些条目不该
 * 各挂一个定时器**，一个几十轮的会话会挂出几十个永远滴答的 interval，
 * 每次触发都让整棵会话流重算。
 *
 * 停止原因恒为 null——还没停，没有原因可说。
 */
function LiveRunBar() {
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    if (!state.running) return
    const t = setInterval(() => setNow(Date.now()), 100)
    onCleanup(() => clearInterval(t))
  })

  const elapsed = () => {
    const from = state.runStartedAt
    return from === null ? null : (now() - from) / 1000
  }

  return <RunStatusBar usage={state.usage} stopReason={null} elapsed={elapsed()} running={true} />
}

/** 跑完那一轮的条目。耗时用落库的起止时刻算，和实时那条是同一个含义。 */
function RunCard(props: { item: TranscriptItem }) {
  const run = () => props.item.run
  const elapsed = () => {
    const r = run()
    return r?.endedAt == null ? null : (r.endedAt - r.startedAt) / 1000
  }

  return (
    <Show when={run()}>
      {(r) => (
        <RunStatusBar
          usage={r().usage}
          stopReason={r().stopReason}
          elapsed={elapsed()}
          running={false}
        />
      )}
    </Show>
  )
}

/**
 * 上下文压缩事件。
 *
 * 压缩不能静默发生：用户需要能回答「为什么模型突然不记得前面说过的话了」。
 * 失败尤其要显眼——压缩失败意味着上下文还是满的，下一轮很可能直接报错。
 */
function CompactionCard(props: { item: TranscriptItem }) {
  const c = () => props.item.compaction
  const label = () => {
    const phase = c()?.phase
    if (phase === 'started') return '正在压缩上下文'
    if (phase === 'failed') return compactionFailureLabel(c()?.reasonCode)
    const n = c()?.compactedMessages
    return n ? `上下文已压缩，折叠 ${n} 轮` : '上下文已压缩'
  }
  return (
    <div class="compaction" classList={{ failed: c()?.phase === 'failed' }}>
      <Show when={c()?.phase === 'started'}>
        <IconSpinner size={13} />
      </Show>
      <span>{label()}</span>
    </div>
  )
}

/**
 * 压缩失败的说法。**未知的码不往外露**——`reasonCode` 是给日志看的英文标识，
 * 括号里挂一个 `too_few_messages` 对用户不构成信息，只构成困惑。
 *
 * 「没什么可压的」两种走的也是 failed 通道（用户点了按钮，必须有回音），
 * 但它们不是错误，措辞要分开。
 */
function compactionFailureLabel(code: string | undefined): string {
  const map: Record<string, string> = {
    too_few_messages: '没什么可压缩的，对话还太短',
    nothing_new: '没什么可压缩的，上次压缩后没有新内容',
    empty_summary: '上下文压缩失败：摘要为空',
  }
  return (code && map[code]) || '上下文压缩失败'
}

function ToolGroup(props: { members: TranscriptItem[] }) {
  const tools = () => props.members.filter((m) => m.kind === 'tool')
  const running = () => tools().some((t) => t.status === 'running')
  const failed = () => tools().some((t) => t.status === 'failure')

  // 组头文案里已经带了「，N 个失败」，右侧不再挂一个计数——
  // 那个数字回答不了任何问题，只是把行尾占满。
  return (
    <Fold
      failed={failed()}
      running={running()}
      autoOpen={running()}
      quietWhenOpen
      label={groupTitle(props.members)}
    >
      <div class="fold-group">
        <For each={props.members}>
          {(m) => (
            <Show when={m.kind === 'tool'} fallback={<ThinkingFold item={m} />}>
              <ToolCard item={m} />
            </Show>
          )}
        </For>
      </div>
    </Fold>
  )
}

function ToolCard(props: { item: TranscriptItem }) {
  return (
    <Fold
      failed={props.item.status === 'failure'}
      superseded={props.item.superseded === true}
      running={props.item.status === 'running'}
      label={actionLabel(props.item)}
      statusWord={statusWord(props.item.status)}
      {...(props.item.action?.target ? { target: props.item.action.target } : {})}
    >
      <StepBody item={props.item} />
    </Fold>
  )
}

/**
 * 展开体。**必须给出标题行没有的东西**，而且**一种动作一种主体**，
 * 不是把所有可能的块堆在一起。
 *
 * 只渲染 `outcome.message` 等于复述标题行：「读取 packages/server/src/git.ts」
 * 展开后看到「读取 packages/server/src/git.ts（278 行）」，用户点了一下什么也没多
 * 知道。真正有信息的是参数——改的 diff、跑的命令、读的范围，全在 `args` 里。
 *
 * 分法：
 *   失败  错误正文 →（分隔线）→ 参数表
 *   编辑  diff →（分隔线）→ 结果
 *   运行  命令原文 →（分隔线）→「输出」标签 + 输出
 *   创建  新内容全文 → 结果
 *   其余  参数表 →（分隔线）→ 结果
 *
 * 「结果」这一格取 `outcome.data`（`content` / `stdout` / `entries` / `matches`），
 * 取不到才回落到 `message`——message 只是一句摘要，不是正文。
 *
 * **自带主体块的那几支一律 `noMessage`。** 编辑和创建的 message 是
 * 「编辑 x（1 处）」「创建 x」，与标题行的「修改文件 · x」逐字重合，
 * 回落出来就是正文底下再挂一个复述标题的灰块。没有主体块的「其余」那一支
 * 要留着回落：搜索零命中时，那句「匹配 0 个文件」是展开体里唯一的结论。
 */
function StepBody(props: { item: TranscriptItem }) {
  const args = () => props.item.args ?? {}
  const rows = () => argsRows(args())
  const kind = () => props.item.action?.kind

  return (
    <Switch fallback={<Generic item={props.item} />}>
      <Match when={props.item.status === 'failure'}>
        <pre class="fold-out err">{props.item.outcome?.message || '（没有错误正文）'}</pre>
        {/*
         * **失败也要把输出带出来。** 只给一句 message 加一张参数表是不够的：
         * message 只是摘要，命令失败时它就是「命令退出码 1」这七个字。用户展开一张
         * 失败的命令卡看到「跑了什么」和「失败了」，唯独没有「它到底吐了什么」，
         * 也就无从判断是命令不对还是被测的东西不对。
         *
         * `noMessage` 是因为上面那行已经把 message 显示过了，回落会原样重复一遍。
         */}
        <Result item={props.item} label="输出" withDivider noMessage />
        <Show when={rows().length > 0}>
          <div class="fold-divider" />
          <ArgsTable rows={rows()} />
        </Show>
      </Match>

      <Match when={kind() === 'edit' && diffFrom(args()) !== null}>
        {(() => {
          const d = diffFrom(args())!
          return (
            <pre class="fold-diff">
              <Show when={d.removed}>
                <span class="del">{d.removed}</span>
              </Show>
              <Show when={d.added}>
                <span class="add">{d.added}</span>
              </Show>
            </pre>
          )
        })()}
        <Result item={props.item} withDivider noMessage />
      </Match>

      <Match when={kind() === 'run'}>
        <Show when={firstString(args(), 'command', 'script', 'code')}>
          {(cmd) => <pre class="fold-code">{cmd()}</pre>}
        </Show>
        <Result item={props.item} label="输出" withDivider />
      </Match>

      <Match when={kind() === 'write' && firstString(args(), 'content', 'text') !== ''}>
        <pre class="fold-code">{clamp(firstString(args(), 'content', 'text'))}</pre>
        <Result item={props.item} noMessage />
      </Match>
    </Switch>
  )
}

function Generic(props: { item: TranscriptItem }) {
  const rows = () => argsRows(props.item.args ?? {})
  return (
    <>
      <Show when={rows().length > 0}>
        <ArgsTable rows={rows()} />
      </Show>
      <Result item={props.item} withDivider={rows().length > 0} />
    </>
  )
}

/**
 * 结果那一格。
 *
 * 取值顺序：`data.content` → `data.stdout` → `data.stderr` → 列表型 → `outcome.message`，
 * **失败时把 `stderr` 提到最前**：报错基本只写在错误流里，而 stdout 常常另有内容
 * （测试的进度输出、服务器的启动日志），按成功时的顺序取就会拿到它、把真正的
 * 报错挡在后面。空的时候整格不渲染——一个空 `<pre>` 只会在展开体里留一道
 * 没有内容的边框。
 */
function Result(props: {
  item: TranscriptItem
  label?: string
  withDivider?: boolean
  /**
   * 取不到正文时不要回落到 `outcome.message`。
   *
   * 两种情况要给：调用方自己已经把 message 显示过了（失败那一支），
   * 或者 message 只是标题行的复述（编辑、创建）。
   */
  noMessage?: boolean
}) {
  const text = () => {
    const data = (props.item.outcome?.data ?? {}) as Record<string, unknown>
    const keys =
      props.item.status === 'failure'
        ? ['stderr', 'content', 'stdout']
        : ['content', 'stdout', 'stderr']
    for (const k of keys) {
      if (typeof data[k] === 'string' && (data[k] as string).trim()) return data[k] as string
    }
    const list = listOf(data)
    if (list) return list.join(NEWLINE)
    return props.noMessage ? '' : (props.item.outcome?.message ?? '')
  }

  return (
    <Show when={text().trim()}>
      {(body) => (
        <>
          <Show when={props.withDivider}>
            <div class="fold-divider" />
          </Show>
          <Show when={props.label}>
            <div class="fold-tag">{props.label}</div>
          </Show>
          <pre class="fold-out">{clamp(body())}</pre>
        </>
      )}
    </Show>
  )
}

const NEWLINE = String.fromCharCode(10)

function ArgsTable(props: { rows: [string, string][] }) {
  return (
    <table class="args-table">
      <tbody>
        <For each={props.rows}>
          {([k, v]) => (
            <tr>
              <th>{k}</th>
              <td>{v}</td>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  )
}

/**
 * 错误码 → 用户的下一步动作。
 *
 * 只写「动作」，不复述错误本身——message 已经说了发生了什么，再重复一遍
 * 只是把卡片撑长。没有明确动作的码返回空串，宁可不显示也不写正确的废话。
 */
function errorHint(code: string): string {
  const map: Record<string, string> = {
    no_api_key: '还没配 API Key：设置 → 模型，在对应接口下填。',
    auth_failed: 'Key 存在但不被接受：确认没抄错、没过期、账号有该模型的权限。',
    insufficient_quota: '账户额度用完了，重试不会好转。',
    rate_limited: '触发限速，等一会儿再重试。',
    model_not_found: '模型 ID 或接口地址对不上：在模型选择器里换一个。',
    context_overflow: '上下文超出窗口：压缩这轮对话，或换一个窗口更大的模型。',
    network_error: '连不上接口地址：检查网络与代理，以及 baseUrl 是否写对。',
    permission_denied: '有操作被权限规则拒绝了：看工具卡片上的拒绝理由，改写这一步或调整权限规则。',
  }
  return map[code] ?? ''
}
