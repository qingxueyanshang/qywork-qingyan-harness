import type { RunUsage, StopReason } from '@qywork/core'
import { formatMoney } from '@qywork/core'
import type { JSX } from 'solid-js'
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack,
} from 'solid-js'
import { createStreamRenderer, renderMarkdown } from '../lib/markdown.ts'
import {
  actionLabel,
  buildRenderItems,
  groupTitle,
  type RenderItem,
  reconcileRenderItems,
} from '../lib/render-items.ts'
import {
  argsRows,
  CLI_PREFIX,
  clamp,
  collapseCarriageReturns,
  compact,
  delegateGraph,
  diffFrom,
  displayTarget,
  fileDelta,
  firstLine,
  firstString,
  type GraphNode,
  hitRate,
  listOf,
  sanitizeTarget,
  statusWord,
  stopReasonLabel,
  todosOf,
} from '../lib/step-view.ts'
import { isRunning, setState, state, type TranscriptItem } from '../lib/store/index.ts'
import { openCliTab, openConversationTab } from '../lib/store/ui.ts'
import { reparseSkip } from '../lib/stream-pace.ts'
import { AttachmentThumb } from './AttachmentThumb.tsx'
import { IconSpinner } from './Icons.tsx'
import { TodoList } from './TodoList.tsx'

/**
 * 会话流。
 *
 * 读数条（`LiveRunBar`）就是流里的**最后一条内容**，跟着流一起滚，往上翻它就翻走
 * ——不钉在底边。它离输入框那段固定距离由 `.transcript-inner` 的下内边距给。
 * 「内容长了不再把它往下顶出视口」不靠 CSS 钉，靠下面那条贴底跟随。
 */
export function Transcript() {
  let scroller!: HTMLDivElement
  let inner!: HTMLDivElement
  const [pinned, setPinned] = createSignal(true)
  /**
   * 本组件写下去的那个 scrollTop（写完读回来的值）。`-1` = 还没写过。
   *
   * **必须读回来**：写下去的目标会被浏览器夹到 `scrollHeight - clientHeight`，
   * 记着没夹过的那个数，下面那句「这次滚动由本组件写入」永远判不成立。
   */
  let followTop = -1

  const stickToBottom = () => {
    scroller.scrollTop = scroller.scrollHeight
    followTop = scroller.scrollTop
  }

  /*
   * 跟不跟随，**只由用户的手势改，不由某一次滚动事件里的几何决定**。
   *
   * 判据不能只看「这次事件里离底多少」：滚动事件不保证在几何稳定的那一刻到达——
   * 补偿后写下去的那次滚动，其事件排在下一帧，而那一帧可能已经又落了一段内容。因此处理器读到的是
   * 「新的 scrollHeight ＋旧的 scrollTop」= 离底几十像素，被判成「用户往上翻了」，
   * 跟随就此关掉；关掉之后离底只会越来越大，**再也不会自己回来**。
   *
   * 实测（真服务真前端，假 provider 驱动一轮四步：`.probe-ws`）：跟随在第 5 秒关掉，
   * 之后 379 个安静帧稳定停在离底 253px——新来的内容全在视口下面，读数条被顶出屏幕。
   * 不要用 `position: sticky` 粘住读数条：粘住的只是那一条，滚动位置仍停在离底
   * 两百多像素，正文仍不可见，而「跳」变成「每次内容变矮时对回一次」。
   *
   * 正确做法是先认出本组件写入的那次滚动并放过它（`mine`），剩下的才是用户手势。
   * 容差 2px 只留给分数像素（scrollTop 是小数，另两个是整数）。
   */
  const onScroll = () => {
    const mine = Math.abs(scroller.scrollTop - followTop) < 1
    const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
    setPinned(mine || gap <= 2)
  }

  /*
   * 贴着底时让新内容跟着走。触发条件是**内容的真实高度变了**，不是「store 里某几个
   * 字段变了」：工具卡跑完才填进参数表和输出、图片解码完才占位、代码块要等高亮
   * 落地——盯字段的话这些全都追不上，新来的字停在视口下面看不见。
   *
   * ResizeObserver 的回调在布局之后、绘制之前跑，所以补偿这一帧就完成，
   * 中间那一帧不会画出去。
   *
   * **两个盒子都要盯。** 内容长高是一件事，而滚动区自己变矮（窗口缩了、输入框长高）
   * 同样把末尾内容推到视口下面，那时 `inner` 的高度一个像素都没动，只盯它就漏了。
   */
  onMount(() => {
    const ro = new ResizeObserver(() => {
      if (pinned()) stickToBottom()
    })
    ro.observe(inner)
    ro.observe(scroller)
    onCleanup(() => ro.disconnect())
  })

  return (
    <div class="transcript" ref={scroller} onScroll={onScroll}>
      <div class="transcript-inner" ref={inner}>
        <TranscriptRows items={state.transcript} />

        {/*
         * 没有 run 收尾条可挂的那些错误。
         *
         * **报错正文的正常落点是读数条**（`run.finished` 时并进那一轮的条目里），
         * 一句话一个地方。这里只收另一半：`run.error` 之后没有 `run.finished`
         * 的那些——没配 key、档案解析失败、会话已有任务在跑、找不到项目目录。
         * 它们连 run 行都没有，不在这儿说就一个字都看不到。
         *
         * 不给引导文案、不给重试按钮：正文本身已经说了该干什么
         * （`ai/src/errors.ts` 的分类文案就是按「用户的下一步动作」写的），
         * 再挂一句是同一件事说两遍；要重发，输入框一直在。
         */}
        <Show when={state.error}>
          {(e) => (
            <div class="error-card" role="alert">
              {e().message}
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
        <Show when={isRunning()}>
          <LiveRunBar />
        </Show>
      </div>
    </div>
  )
}

/**
 * 静默多久就改口说实话。
 *
 * **这个数是保守选择，不是测量结果。** 账本里有整轮往返的分布（p90 约 32 秒），
 * 但那是**整轮**的数，不是**两个事件之间**的数，拿它当间隔阈值是偷换——
 * 后者本仓目前测不出来（`provider_requests` 只记 `sent_at`，不记首个事件何时到）。
 *
 * 取宽只影响这句话出现的早晚；它替掉的那句在任何时长下都是假的，
 * 所以宁可晚说，也不要继续说假的。
 */
const SILENT_MS = 30_000

/**
 * 这一轮此刻在**哪个阶段**。
 *
 * 五态，句式平齐：正在请求 / 正在思考 / 正在执行 / 正在回复 / 正在重连 N / M；
 * 外加一档「已 N 秒没有新数据」——它不是第六种阶段，是**前五种全都不再为真**时
 * 唯一诚实的说法。
 *
 * 这一格说的是阶段，不是动作。工具组头那句说的才是这一批工具在做什么
 * （查询 / 读取 / 创建 / 修改 / 删除 / 运行 / 调用），两者粒度不同、不重复——
 * 动作轴里也没有「执行」这个词，不会撞。
 *
 * 按**流的位置**判断，而不是按快照推：从时间线快照反推会慢半拍，
 * 而这行字的全部意义就是「它现在有反应」。
 *
 * **为什么必须有「正在请求」这一档。** 只有三档、拿「正在回复」兜底是不成立的：刚发出消息那一刻，流
 * 的最后一条是用户自己那句话——回车之后立刻显示「正在回复…」，紧接着出现的却是思考内容。那句话
 * 在它为真之前就说了：请求刚发出，模型一个字都还没输出。
 *
 * **为什么「正在执行」要看 `status`。** 只看 `kind === 'tool'` 的话，工具跑完之后到模型回包之间这一
 * 整段都在说「正在执行…」——而那段是最容易出事的一段（实测一次断流就断在这之后的 262 秒里）。工
 * 具卡有终态，用它判：**在跑才叫在执行，跑完了是在等回包**。
 *
 * **静默那一档为什么要绕开两种情形。** 工具还在跑时绕开：一次构建十分钟很正常，而它自己
 * 会出 stdout，那种情况下报静默是假话。
 */
function liveStatus(now: number): string {
  const last = state.transcript[state.transcript.length - 1]
  if (last?.kind === 'tool' && last.status === 'running') return '正在执行…'

  /*
   * 连接不在 ready 上时**这一格什么都不说**。
   *
   * 下面那句「已 N 秒没有新数据」在字面上仍然为真，但它把「对端没了」说成了
   * 「数据慢」——用户会继续等，而实际上服务端已经不在，停止按钮也没人接。
   * 真正的答案由顶部那条连接横幅给（它还带重试倒计时），这里再说一遍就是两处
   * 各写一份、迟早漂成两句话。
   */
  if (state.connection !== 'ready') return ''

  /*
   * 重发中的那一段：末条是失败那次留下的半截思考，按流的位置判会说成「正在思考…」
   * ——而此刻模型一个字都没在写。上限的数由事件带来，不在这里写死。
   */
  const retry = state.retry
  if (retry) return `正在重连 ${retry.attempt} / ${retry.max}…`

  const since = state.lastEventAt ?? state.runStartedAt
  if (since !== null && now - since >= SILENT_MS) {
    return `已 ${Math.round((now - since) / 1000)} 秒没有新数据`
  }

  if (last?.kind === 'thinking') return '正在思考…'
  if (last?.kind === 'text') return '正在回复…'
  return '正在请求…'
}

/**
 * assistant 正文。
 *
 * 只有「运行中且是最后一条」才按流式渲染（`createStreamRenderer`，关闭语言自动检测）；
 * 定稿后整段重渲染一次并开启检测，那一次同时纠正增量渲染的已知偏差。
 *
 * **这里不许再加一层限速。** 正文进 store 的节奏**已经由 `stream-pace.ts` 定死**：50ms 一档，每档按
 * 上游流速放几个字。在这之上再套一个自己的定时器，两级串起来是这样的——第一次变化排一个 60ms 的
 * timer，期间的变化被合并，落地后 timer 清空，下一次变化再排 60ms：**稳态变成每 100ms 落地一次、
 * 每次落两档的量**。20Hz 的匀速被压成 10Hz 的跳变，正文成批出现而不是连续流出。
 *
 * **DOM 只动活动区。** 已定稿的块贴进容器就不再碰，每档只删掉它们之后那几个节点再贴一次活动区。
 * **不要把两个区各包一个 `<div>`**：`transcript.css` 的 `.markdown > :first-child` /
 * `:last-child` / `p:last-child` 是按容器的直接子元素写的，包一层这三条全部失效
 * （首尾的外边距塌不掉，两个区之间多出一截）。
 *
 * 整段替换 `innerHTML` 的代价不只是重建节点：33KB 的 HTML 实测 7.8ms、66KB 15.5ms
 * （2026-08-20，真实 Chromium），且流式期用户选中的文字每档被销毁一次，复制不了。
 */
function Prose(props: { item: TranscriptItem }) {
  const streaming = () =>
    isRunning() && state.transcript[state.transcript.length - 1]?.id === props.item.id

  // 解析闸门：`reparseSkip` 说了算，判据与理由都在它那里。
  const [gate, setGate] = createSignal(0)
  let sinceParse = 0
  let lastCost = 0

  createEffect(() => {
    const text = props.item.text
    if (!streaming()) {
      // 定稿：立刻对齐到全文，否则最后几档会永远停在上一帧。
      sinceParse = 0
      setGate(text.length)
      return
    }
    sinceParse++
    if (sinceParse >= reparseSkip(lastCost)) {
      sinceParse = 0
      setGate(text.length)
    }
  })

  let host: HTMLDivElement | undefined
  const stream = createStreamRenderer()
  /** 已定稿区占了容器前面多少个子节点。活动区永远是它之后的那些。 */
  let settledNodes = 0

  createEffect(() => {
    gate()
    /*
     * `streaming()` 必须**订阅**，不能塞进下面的 `untrack`。
     *
     * 定稿那一下常常不改变文本长度——末档的字在 `run.finished` 之前就冲进 store 了，
     * 因此闸门写回同一个值、信号不通知。只认闸门的话整段重渲染永远不会发生，
     * 而语言自动检测和增量渲染的已知偏差都指着它纠正。
     * 它自己不会每档变：读的是末项的 id，往末项追加文本不动 id。
     */
    const live = streaming()
    // 只认闸门：直接读 text 会让这个 effect 依赖它，降频就失效了。
    const text = untrack(() => props.item.text)
    if (!host) return

    const t0 = performance.now()
    if (live) {
      const chunk = stream.push(text)
      if (chunk.reset) {
        host.textContent = ''
        settledNodes = 0
      }
      for (let extra = host.childNodes.length; extra > settledNodes; extra--) {
        host.lastChild?.remove()
      }
      // 内容经 markdown.ts 净化后才进 DOM —— 模型输出不可信
      if (chunk.settled) {
        host.insertAdjacentHTML('beforeend', chunk.settled)
        settledNodes = host.childNodes.length
      }
      if (chunk.live) host.insertAdjacentHTML('beforeend', chunk.live)
    } else {
      host.innerHTML = renderMarkdown(text)
      settledNodes = host.childNodes.length
    }
    lastCost = performance.now() - t0
  })

  return (
    <div class="row assistant" classList={{ superseded: props.item.superseded }}>
      <div class="prose markdown" ref={host} />
    </div>
  )
}

/**
 * 折叠：思考、工具、工具组共用的**同一个**形状。
 *
 * 不要让它们长成三样（思考一个左边框、工具一张卡片、工具组另一张更大的卡片）：
 * 三种形状在同一列里交替出现，而它们在语义上是同一类条目——**这一轮里发生了
 * 一件可以展开看的事**。
 *
 * 用原生 `<details>` 而不是自己管 open 状态：键盘语义、`Enter`/`Space` 展开、
 * 屏幕阅读器的展开态播报都由元素自带，自写 button + signal 每一样都要补。
 */
function Fold(props: {
  label: string
  /** 终态字样。**成功不写字**——一屏几十行全是「成功」等于没有信息。 */
  statusWord?: string
  target?: string
  /**
   * 改了多少行。**钉在行尾，不进文本槽**——文本槽负责单行省略，
   * 目标一长这两个数就会跟着被截掉，而它们是定宽的事实。
   */
  changes?: { additions: number; deletions: number }
  /** 思考那类「背景信息」压暗一档，hover 时恢复。 */
  dim?: boolean
  failed?: boolean
  superseded?: boolean
  children: JSX.Element
}) {
  /*
   * **开合只由用户点，谁都不许替他开、替他合。**
   *
   * **不要加 `autoOpen`**（思考跑起来自动展开、跑完自动收起，工具组同理）：那是会话流
   * 「一直上下跳动」的根——`.fold-pre` 一次开合就是 200px，而一轮里有好几段思考、
   * 好几组命令，因此内容高度在跑的过程中反复变矮又变高。实测一轮四步：会话流高度
   * 变矮 5 次，幅度 58 / 82 / 122 / 146 / 191px（`.probe-ws` 那份探针）。
   * 贴着底看的用户因此被动经历几百像素的来回位移，而他没有做任何操作。
   *
   * 收起态并不少信息：思考那条的标签里带着**实时更新的正文摘要**，工具组的标题写着
   * 干了什么。要看全的自己点开——点开之后也不会被自动合上。
   *
   * 开合完全归 `<details>` 自己管：这里不留 open 信号，也就没有第二本账。
   */
  return (
    <details
      class="fold"
      classList={{ 'fold-dim': props.dim, failed: props.failed, superseded: props.superseded }}
    >
      {/* 一整行不换行：文本槽负责省略，右侧的角标不收缩。 */}
      <summary class="fold-head">
        <span class="fold-summary">
          <span class="fold-label">{props.label}</span>
          <Show when={props.statusWord}>
            <span class="fold-word">{props.statusWord}</span>
          </Show>
          <Show when={props.target}>
            <span class="fold-target" data-tip={props.target}>
              · {sanitizeTarget(props.target!)}
            </span>
          </Show>
          {/* 改了多少行**紧跟在文件名后面**，不钉行尾：它说的是这个文件的事，
              隔着半行空白放到最右边，眼睛要横扫过去才能把两者对上。
              路径长时截的是路径（`.fold-target` 自己收缩），这两个数不收缩。 */}
          <Show when={props.changes}>
            {(c) => (
              <span class="fold-delta">
                <span class="fold-add">+{c().additions}</span>
                <span class="fold-del">−{c().deletions}</span>
              </span>
            )}
          </Show>
        </span>
      </summary>
      <div class="fold-body">{props.children}</div>
    </details>
  )
}

function ThinkingFold(props: { item: TranscriptItem }) {
  const streaming = () =>
    isRunning() && state.transcript[state.transcript.length - 1]?.id === props.item.id
  // 流仍在增长时说「思考中」，停了说「已思考」——避免出现
  // 「标签写着已思考、旁边转圈说正在思考」的自相矛盾。
  const verb = () => (streaming() ? '思考中' : '已思考')
  const preview = () => props.item.text.replace(/\s+/g, ' ').trim().slice(0, 80)

  /*
   * 思考块自己滚到底。
   *
   * `.fold-pre` 是**内层滚动容器**（max-height 200px），会话流那个「贴着底就跟随」
   * 只作用在外层。用户在思考还在流的时候点开它，不跟随的话它停在第一屏——
   * 新来的字一直往下堆在看不见的地方，看起来像卡住了。
   *
   * 只在流式期跟随：停下来之后用户往回翻，不该被强制滚回底部（那正是外层刻意避免的）。
   */
  let pre: HTMLPreElement | undefined
  createEffect(() => {
    void props.item.text
    if (streaming() && pre) pre.scrollTop = pre.scrollHeight
  })

  return (
    <Fold dim label={preview() ? `${verb()} — ${preview()}` : verb()}>
      <pre class="fold-pre" ref={pre}>
        {props.item.text}
      </pre>
    </Fold>
  )
}

/**
 * 运行中的中途输出。
 *
 * 只在工具还在跑的时候出现；跑完由展开体那几个终态分支接手，不会两块并存。
 *
 * 自己滚到底的理由与思考块相同：`.fold-live` 是**内层滚动容器**，
 * 会话流那个「贴着底就跟随」只作用在外层，不跟随的话新来的行一直堆在看不见的地方。
 */
function LiveOutput(props: { item: TranscriptItem }) {
  let pre: HTMLPreElement | undefined
  createEffect(() => {
    void props.item.stdout
    if (pre) pre.scrollTop = pre.scrollHeight
  })
  return (
    <pre class="fold-live" ref={pre}>
      {collapseCarriageReturns(props.item.stdout ?? '')}
    </pre>
  )
}

/**
 * Run 收尾条：停止原因 + 真实用量 + 耗时。**一轮一条。**
 *
 * **为什么收数据靠 props 而不是读 store。** 读 `state.usage` / `state.stopReason` /
 * `state.runStartedAt` 那几个全局字段的话，整个会话只会有一条：第二轮跑完把第一轮的读数冲掉，刷新
 * 更是一条不剩。而这些数字逐轮落在 `runs` 表里——一轮一个条目、由投影层从 run 行重建，才是它本来
 * 的形状。
 *
 * 跑完的那一轮走 `props.run`；还在跑的那一轮没有 run 行可读，
 * 由 `<LiveRunBar />` 拿实时状态渲染同一个外壳。
 *
 * 三条口径必须守住：
 * - **停止原因永远显示**，正常完成也显示（只是低调）。废除「静默 done」的意义
 *   就在于用户不用追问「它怎么停了」。
 * - **缓存命中显示「未回报」的门槛只有一条**：那一次连 usage 都没回来。
 *   回了 usage 但没有缓存字段的算 0——那一次的钱就是按零命中付的。
 * - 计价为 0 时不显示金额，而不是显示 $0.0000——未知计价冒充免费更误导。
 */
function RunStatusBar(props: {
  usage: RunUsage | null
  stopReason: StopReason | null
  /** 秒。null = 没有可信的起止时刻，不显示这一格。 */
  elapsed: number | null
  running: boolean
  /**
   * 跑着的时候这一格说什么。
   *
   * 由调用方给而不是这里现算：它要按**当下**判静默，而只有 `LiveRunBar` 那层
   * 挂着走秒的定时器——在这里读 `Date.now()` 的话，画面不会自己更新。
   */
  liveNote?: string
  /** 报错正文，没有就是 null。有它时它**取代**停止原因那句话，不是并列多说一句。 */
  errorMessage?: string | null
}) {
  const normal = () => !props.stopReason || props.stopReason === 'completed'
  /**
   * 停下来的说法。
   *
   * **有正文就说正文**：「模型服务出错」只说了是谁的错，而「网络不可达：检查接口
   * 地址与代理」才说得出该干什么——两句一起显示是同一件事说两遍，而这一格
   * 排在读数条末位，本来就是留给「为什么停」的。
   *
   * 只取第一行：个别正文会带上配置文件路径那种第二行，而读数条只有一行，
   * 整段贴进来会把这一行撑开、把前面几格挤走。
   */
  const reason = () => {
    const detail = props.errorMessage?.split(NEWLINE)[0]?.trim()
    return detail || stopReasonLabel(props.stopReason!)
  }

  return (
    <div class="run-strip" classList={{ done: !props.running, abnormal: !normal() }}>
      {/* 星河条：运行时星点流动、五格逐个提亮扫过去，跑完暂停动画并压暗——「还在跑」
          和「跑完了」必须在余光里就能分清，光靠文字变化做不到。
          五格分开写：每格自己一条错开延时的动画，也各带各的星点数。 */}
      <span class="run-galaxy" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
        <span />
      </span>

      <span class="run-readout">
        <Show when={props.elapsed !== null}>
          <span class="run-metric run-elapsed" data-tip="本轮耗时">
            {props.elapsed!.toFixed(1)}s
          </span>
        </Show>
        <Show when={props.usage}>
          {(usage) => (
            <>
              <span class="run-metric" data-tip="输入 / 输出 token">
                ↓{compact(usage().inputTokens)} ↑{compact(usage().outputTokens)}
              </span>
              {/* 口径（分母是输入总量、取最后一次调用、什么时候算 0）全在 `hitRate` 上，
                  这里不复述——两处各写一遍必然漂移。 */}
              <span class="run-metric" data-tip="最后一次模型调用的缓存命中占输入总量的比例">
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
        <Show when={props.running && props.liveNote}>
          <span class="run-live">{props.liveNote}</span>
        </Show>
        {/* 停止原因排在**末位**：它长度不定，排在最前会把后面几格读数整体右推，
            因此出错的那一轮和正常的那些轮列对不齐。放最后，前面几格的列位恒定。 */}
        <Show when={!normal()}>
          <span class="run-reason">{reason()}</span>
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
    if (!isRunning()) return
    const t = setInterval(() => setNow(Date.now()), 100)
    onCleanup(() => clearInterval(t))
  })

  const elapsed = () => {
    const from = state.runStartedAt
    return from === null ? null : (now() - from) / 1000
  }

  return (
    <RunStatusBar
      usage={state.usage}
      stopReason={null}
      elapsed={elapsed()}
      running={true}
      liveNote={liveStatus(now())}
    />
  )
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
          errorMessage={r().errorMessage}
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
    if (phase === 'skipped') return compactionSkipLabel(c()?.reasonCode)
    if (phase === 'failed') return compactionFailureLabel(c()?.reasonCode)
    // 三种形态要能分辨：只收纳（没调模型）/ 压缩完成 / 收纳了但摘要没做成。
    // 都说成「已压缩」的话，一次没调模型的收纳和一次完整压缩在用户那边一模一样。
    if (c()?.summarized === false) {
      return c()?.reasonCode ? '上下文已收纳，摘要未完成' : '上下文已收纳，未调用模型'
    }
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

/** 没什么可压。**不是失败**，所以不走红字通道，措辞也不带「失败」。 */
function compactionSkipLabel(code: string | undefined): string {
  const map: Record<string, string> = { nothing_to_fold: '无可压缩内容' }
  return (code && map[code]) || '无可压缩内容'
}

/**
 * 压缩失败的说法。**未知的码不往外露**——`reasonCode` 是给日志看的英文标识，
 * 括号里挂一个 `empty_summary` 对用户不构成信息，只构成困惑。
 */
function compactionFailureLabel(code: string | undefined): string {
  const map: Record<string, string> = {
    summary_empty: '压缩失败：摘要为空',
    summary_error: '压缩失败：摘要调用出错',
    no_headroom: '压缩失败：没有可用空间',
    not_smaller: '压缩失败：摘要没有更小',
  }
  return (code && map[code]) || '压缩失败'
}

/**
 * 会话流的正文行。父会话与右侧面板里那条只读子会话**共用这一份**——
 * 各画一遍的话，将来加一种条目必然漏掉其中一处。
 *
 * 滚动跟随不在这里：那件事只有父会话要，它在 `Transcript` 里。
 */
export function TranscriptRows(props: { items: TranscriptItem[] }) {
  // 带对账的投影：没变的行沿用上一轮的对象，`<For>` 才不会把整列 DOM 重建掉
  // （重建的代价是展开着的折叠会自己合上，见 reconcileRenderItems）。
  const items = createMemo<RenderItem[]>((prev = []) =>
    reconcileRenderItems(prev, buildRenderItems(props.items)),
  )
  return (
    <>
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
                          <span class="attach-chip" data-tip={a.path}>
                            <AttachmentThumb path={a.path} name={a.name} box={44} />
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
    </>
  )
}

function ToolGroup(props: { members: TranscriptItem[] }) {
  const tools = () => props.members.filter((m) => m.kind === 'tool')
  const failed = () => tools().some((t) => t.status === 'failure')

  // 组头文案里已经带了「，N 个失败」，右侧不再挂一个计数——
  // 那个数字回答不了任何问题，只是把行尾占满。
  return (
    <Fold failed={failed()} label={groupTitle(props.members)}>
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

/**
 * 派活的图卡。**派一件与派一张图共用这一张**——一次派活就是一张只有一格的图，
 * 两种画法并存的代价是同一件事在会话流里长两个样。
 *
 * **形状来自参数，状态来自事件或结果。** 参数随 `tool.started` 就到，所以第一帧就能
 * 把整张图画全，等着跑的格子也在图上；状态在流式期来自 `team.member` 事件
 * （`item.nodes`），刷新之后来自落库的终态。两条路各管一段，不互相兜底——进度事件不落库。
 *
 * 按依赖分层排：同一层的并排（它们真的在并行跑），层与层之间一条竖线。
 * 这就是「谁等谁」的全部信息，不画箭头——节点一多，箭头会把图糊成一团线。
 */
function DelegateCard(props: { item: TranscriptItem }) {
  const graph = () => delegateGraph(props.item)

  /**
   * 一格现在什么状态。会话端点没有状态——它是这条会话本身。
   *
   * **三条来源各管一段**：进度事件（流式）· 编排结果里的逐节点终态（刷新之后的一张图）·
   * 这条 step 自己（刷新之后的一次派活——那一格就是这条 step）。
   * 第三条与前两条不是兜底关系：派一件的结果里本来就没有逐节点终态，
   * 那一格的成败、耗时全在 step 账上。
   */
  const stateOf = (n: GraphNode) => {
    if (n.kind === 'session') return null
    const live = props.item.nodes?.find((x) => x.nodeId === n.key)
    if (props.item.toolName !== 'workflow') {
      const settled =
        props.item.status === 'success' ? 'done' : props.item.status === 'failure' ? 'failed' : null
      return {
        phase: live?.phase ?? settled ?? 'working',
        label: live?.label ?? '',
        // 耗时不在进度事件里，它随 `tool.finished` 落进这条 step。
        durationMs: props.item.durationMs,
        conversationId: live?.conversationId ?? flatConversationId(props.item),
      }
    }
    if (live) {
      return {
        phase: live.phase,
        label: live.label,
        durationMs: live.durationMs,
        conversationId: live.conversationId,
      }
    }
    // 回放这条路读的是落库的结果，**字段名与事件那条路不同**：结果里是
    // `status`（done/failed/skipped），事件里是 `phase`（还多 spawned/working）。
    // 照着事件的名字去读结果，每个节点都会退化成「等着跑」——刷新一次整张图全灰。
    const back = (
      props.item.outcome?.data as
        | {
            nodes?: {
              nodeId: string
              agent: string
              label?: string
              status: string
              durationMs?: number
              conversationId?: string
            }[]
          }
        | undefined
    )?.nodes?.find((n2) => n2.nodeId === n.key)
    return back
      ? {
          phase: back.status,
          label: back.label || back.agent,
          durationMs: back.durationMs,
          conversationId: back.conversationId,
        }
      : null
  }

  /**
   * 连线按 `needs` 逐条画，**不是按层画**：跨层的依赖（第 1 层直接连到第 3 层）
   * 也是真实存在的边，只连相邻层会把它画丢。
   *
   * 位置只能量出来——节点宽度随名字与耗时变，算不出来。量的时机交给
   * `ResizeObserver`：它在布局之后、绘制之前回调，所以线和方块同一帧落地，
   * 不会先画出一张错位的图再纠正。线是绝对定位的 SVG，不参与布局，
   * 所以量→画这一步不会再触发一次布局（不构成观察循环）。
   */
  const [edges, setEdges] = createSignal<{ d: string; live: boolean }[]>([])
  let box!: HTMLDivElement
  const refs = new Map<string, HTMLElement>()

  const measure = () => {
    if (!box) return
    const b = box.getBoundingClientRect()
    // 半像素：1px 的描边画在整数坐标上会跨两个物理像素，出来是两条半灰的线。
    const at = (v: number) => Math.round(v) + 0.5
    const out: { d: string; live: boolean }[] = []
    const g = graph()
    for (const n of g.nodes) {
      const to = refs.get(n.key)
      if (!to) continue
      const sources = n.needs.map((d) => refs.get(d)).filter((el): el is HTMLElement => !!el)
      if (sources.length === 0) continue
      // 这一组边流不流动，看它汇进去的那个节点在不在跑。
      const phase = stateOf(n)?.phase
      const live = phase === 'spawned' || phase === 'working'
      const t = to.getBoundingClientRect()
      if (g.horizontal) {
        // 三格横排时每条边只连一对格子：左格右缘中点画到右格左缘中点，一条直线。
        const r = sources[0]!.getBoundingClientRect()
        const y = at(t.top + t.height / 2 - b.top)
        out.push({ d: `M${at(r.right - b.left)} ${y}H${at(t.left - b.left)}`, live })
        continue
      }
      const tx = at(t.left + t.width / 2 - b.left)
      const ty = at(t.top - b.top)
      const rects = sources.map((el) => el.getBoundingClientRect())
      const foot = Math.max(...rects.map((r) => r.bottom - b.top))
      const bus = at((foot + (t.top - b.top)) / 2)
      const xs = rects.map((r) => at(r.left + r.width / 2 - b.left))
      /*
       * 汇进同一个节点的几条边**共用一条横线加一根竖线**，不是各画各的折线。
       *
       * 各画各的时候，三条折线的横段与拐角叠在一起，而上游与下游中线差一两个像素
       * 就会在拐角处留下一小截阶梯——看起来像线走歪了。共用之后下游那根始终是直的。
       */
      for (const [i, r] of rects.entries()) {
        out.push({ d: `M${xs[i]} ${at(r.bottom - b.top)}V${bus}`, live })
      }
      const left = Math.min(...xs, tx)
      const right = Math.max(...xs, tx)
      if (right > left) out.push({ d: `M${left} ${bus}H${right}`, live })
      out.push({ d: `M${tx} ${bus}V${ty}`, live })
    }
    setEdges(out)
  }

  const ro = new ResizeObserver(() => measure())
  onCleanup(() => ro.disconnect())
  // 节点的状态变了（跑完了多出一格耗时）宽度会变，重量一次。
  createEffect(() => {
    props.item.nodes
    props.item.outcome
    queueMicrotask(measure)
  })

  /**
   * 容器自己也要观察。**节点定宽，所以拖面板时它们的尺寸一个都不变**——只观察节点的话
   * 观察器不回调，而居中的那一行整体挪了位，线停在上一次的坐标上。
   * 容器宽度是所有节点位置的唯一变量，观察它就补齐了这一类布局变化。
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
    <div class="wf-card" classList={{ failed: props.item.status === 'failure' }}>
      <div class="wf-goal truncate">{cardTitle(props.item)}</div>
      <div class="wf-graph" classList={{ across: graph().horizontal }} ref={holdBox}>
        <svg class="wf-edges" aria-hidden="true">
          <For each={edges()}>{(e) => <path d={e.d} classList={{ live: e.live }} />}</For>
        </svg>
        <For each={graph().layers}>
          {(layer) => (
            <div class="wf-layer">
              <For each={layer}>
                {(n) => {
                  const st = () => stateOf(n)
                  /*
                   * 点一格 = 翻开它。两种格子翻开的内容不同：内置子 agent 有一条
                   * 点得开的子会话；外部 CLI 是本机另一个进程，翻开的是它写出来的那段流。
                   * 两者都没有时（还没跑到）点不开。
                   */
                  const cli = () => n.agent.startsWith(CLI_PREFIX)
                  // 主行：图里那一格的名字。派一件没有节点 id，那一格的名字就是执行者，
                  // 所以运行期拿到更全的那个（厂商 + CLI 名）时用它。
                  const name = () => (n.agentLabel ? n.title : st()?.label || n.title)
                  const open = () => {
                    const cid = st()?.conversationId
                    if (cid) openConversationTab(cid, name())
                    else if (cli()) openCliTab(props.item.id, n.key, name())
                  }
                  return (
                    <Show
                      when={n.kind === 'agent'}
                      fallback={
                        // 两端是这条会话自己：交出去、收回来。不可点——它就是用户正在看的这一页。
                        <div class="wf-node session" ref={hold(n.key)}>
                          <span class="wf-node-name truncate">{n.title}</span>
                        </div>
                      }
                    >
                      <button
                        type="button"
                        class="wf-node"
                        classList={{ [st()?.phase ?? 'waiting']: true }}
                        disabled={!st()?.conversationId && !(cli() && st())}
                        onClick={open}
                        ref={hold(n.key)}
                      >
                        {/* 主行是那一格的名字：一张图里区分得开谁是谁的就是它。
                            执行者压一档——同一张图里常常四格都是同一个。 */}
                        <span class="wf-node-name truncate">{name()}</span>
                        <span class="wf-node-who truncate">
                          <Show when={n.agentLabel}>{st()?.label || n.agentLabel}</Show>
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
      {/* 失败原因。**只印这一处**：边框已经说了「失败了」，这一行说的是为什么。 */}
      <Show when={props.item.status === 'failure' && props.item.outcome?.message}>
        {(msg) => <div class="wf-error">{msg()}</div>}
      </Show>
    </div>
  )
}

/** 卡顶那一行：这次派活整体要达成什么。图是 `goal`，派一件是任务的第一行。 */
function cardTitle(item: TranscriptItem): string {
  const raw = item.toolName === 'workflow' ? item.args?.goal : item.args?.task
  return firstLine(typeof raw === 'string' ? raw.trim() : '')
}

/** 派一件那张卡上的子会话 id：它不在逐节点终态里，就在结果的顶层。 */
function flatConversationId(item: TranscriptItem): string | undefined {
  const cid = (item.outcome?.data as { conversationId?: unknown } | undefined)?.conversationId
  return typeof cid === 'string' && cid ? cid : undefined
}

function ToolCard(props: { item: TranscriptItem }) {
  const changes = () => fileDelta(props.item.outcome?.fileChanges)
  // 派活的那两个画成图，不套折叠：它们各自是一整条子会话的入口，
  // 而产出正文在那条子会话（或那个 CLI 进程的输出流）里本来就有。
  if (props.item.toolName === 'workflow' || props.item.toolName === 'subagent') {
    return <DelegateCard item={props.item} />
  }
  return (
    <Fold
      failed={props.item.status === 'failure'}
      superseded={props.item.superseded === true}
      label={actionLabel(props.item)}
      statusWord={statusWord(props.item.status)}
      {...(props.item.action?.target ? { target: displayTarget(props.item.action.target) } : {})}
      {...(changes() ? { changes: changes()! } : {})}
    >
      <StepBody item={props.item} />
    </Fold>
  )
}

/**
 * 展开体。**必须给出标题行没有的信息**，而且**一种动作一种主体**，
 * 不是把所有可能的块堆在一起。
 *
 * 只渲染 `outcome.message` 等于复述标题行：「读取 packages/server/src/git.ts」
 * 展开后看到「读取 packages/server/src/git.ts（278 行）」，用户点了一下什么也没多
 * 知道。真正有信息的是参数——改的 diff、跑的命令、读的范围，全在 `args` 里。
 *
 * 分法：
 *   失败错误正文 →（分隔线）→ 参数表
 *   待办清单逐行（勾 / 转圈 / 空心点）
 *   编辑  diff →（分隔线）→ 结果
 *   运行命令原文 →（分隔线）→「输出」标签 + 输出
 *   创建新内容全文 → 结果
 *   其余参数表 →（分隔线）→ 结果
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
      {/*
       * 中途输出排在最前。跑着的时候 `outcome` 还不存在，落到下面任何一支
       * 都是一张空卡片；而这一支只在 `status === 'running'` 时成立，
       * 终态一到自动让位，不需要谁去清它。
       */}
      <Match when={props.item.status === 'running' && props.item.stdout}>
        <LiveOutput item={props.item} />
      </Match>

      <Match when={props.item.status === 'failure'}>
        <pre class="fold-out err">{props.item.outcome?.message || '（没有错误正文）'}</pre>
        {/*
         * **失败也要把输出带出来。** 只给一句 message 加一张参数表是不够的：
         * message 只是摘要，命令失败时它就是「命令退出码 1」这七个字。用户展开一张
         * 失败的命令卡看到「跑了什么」和「失败了」，唯独没有它输出了什么，
         * 也就无从判断是命令不对还是被测的代码不对。
         *
         * `noMessage` 是因为上面那行已经把 message 显示过了，回落会原样重复一遍。
         */}
        <Result item={props.item} label="输出" withDivider noMessage />
        <Show when={rows().length > 0}>
          <div class="fold-divider" />
          <ArgsTable rows={rows()} />
        </Show>
      </Match>

      {/*
       * 待办清单。**不能落到通用参数表那一支**：整表 JSON 挤在一格里，
       * 状态埋在 `"status":"in_progress"` 的引号中间，问「哪几条做完了」
       * 得自己数引号。这一支给的是标题行没有的信息——每条的状态。
       *
       * `noMessage`：回执是「第 3/4 步：编写 main.js」，而清单里那一条正带着
       * 转圈的记号，同一件事说两遍。
       */}
      <Match when={todosOf(args()) !== null}>
        <div class="fold-todos">
          <TodoList todos={todosOf(args())!} />
        </div>
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
 * 取值顺序：`data.content` → `data.stdout` → `data.stderr` → `data.output` → 列表型 →
 * `outcome.message`。`output` 这一键留给 MCP 与插件的工具——它们的 data 形状由第三方
 * 决定，这是其中的常见键；内置工具里没有生产者（派活那两个画成图卡，不走这里）。
 *
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
        ? ['stderr', 'content', 'stdout', 'output']
        : ['content', 'stdout', 'stderr', 'output']
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
          <pre class="fold-out">{clamp(collapseCarriageReturns(body()))}</pre>
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
