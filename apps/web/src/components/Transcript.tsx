import { createEffect, createMemo, createSignal, For, Match, Show, Switch } from 'solid-js'
import { renderMarkdown } from '../lib/markdown.ts'
import { actionLabel, buildRenderItems, groupTitle } from '../lib/render-items.ts'
import { retryLastRun, setState, state, type TranscriptItem } from '../lib/store/index.ts'
import { IconCheck, IconChevron, IconSpinner, IconX, toolIcon } from './Icons.tsx'

/**
 * 会话流。
 *
 * 自动滚动只在用户本来就贴着底部时才跟随——往上翻历史时被强行拽回底部是最恼人的
 * 交互之一，而模型输出期间这会每秒发生几十次。
 */
export function Transcript() {
  let scroller!: HTMLDivElement
  const [pinned, setPinned] = createSignal(true)

  const items = createMemo(() => buildRenderItems(state.transcript))

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
                  <div class="bubble">{node.kind === 'user' ? node.item.text : ''}</div>
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
                  之前这里只渲染 message，等于把分类结果丢掉了——同一句
                  「请求失败」下面，该去配 key 和该等一分钟是两种完全不同的处境。 */}
              <Show when={errorHint(e().code)}>{(h) => <span class="hint">{h()}</span>}</Show>
              {/* 曾经这里只是一行「可以重试」的文字，没有任何交互——
                  告诉用户可以做某件事却不给做的入口，比不提更让人恼火。 */}
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

        <Show when={!state.running && state.stopReason}>
          <RunStatusBar />
        </Show>
      </div>
    </div>
  )
}

/**
 * assistant 正文。
 *
 * 只有「运行中且是最后一条」才按流式渲染（关闭语言自动检测）；定稿后重渲染一次
 * 并开启检测。这是原版踩出来的性能取舍，见 markdown.ts 的说明。
 */
function Prose(props: { item: TranscriptItem }) {
  const streaming = () =>
    state.running && state.transcript[state.transcript.length - 1]?.id === props.item.id

  const html = createMemo(() => renderMarkdown(props.item.text, { streaming: streaming() }))

  return (
    <div class="row assistant" classList={{ superseded: props.item.superseded }}>
      {/* 内容经 markdown.ts 净化后才进 innerHTML —— 模型输出不可信 */}
      <div class="prose markdown" innerHTML={html()} />
    </div>
  )
}

function ThinkingFold(props: { item: TranscriptItem }) {
  const [open, setOpen] = createSignal(false)
  const streaming = () =>
    state.running && state.transcript[state.transcript.length - 1]?.id === props.item.id
  // 流仍在增长时说「思考中」，停了说「已思考」——避免出现
  // 「标签写着已思考、旁边转圈说正在思考」的自相矛盾。
  const verb = () => (streaming() ? '思考中' : '已思考')
  const preview = () => props.item.text.replace(/\s+/g, ' ').trim().slice(0, 80)

  return (
    <div class="thinking">
      <button class="thinking-head" type="button" onClick={() => setOpen((v) => !v)}>
        <IconChevron size={12} dir={open() ? 'down' : 'right'} />
        <span class="truncate">{preview() ? `${verb()} — ${preview()}` : verb()}</span>
      </button>
      <Show when={open()}>
        <div class="thinking-body">{props.item.text}</div>
      </Show>
    </div>
  )
}

/**
 * Run 收尾条：停止原因 + 真实用量。
 *
 * 三条口径必须守住：
 * - **停止原因永远显示**，正常完成也显示（只是低调）。废除「静默 done」的意义
 *   就在于用户不用追问「它怎么停了」。
 * - **缓存命中为 null 时显示「未回报」而不是 0**：provider 没回报和真实零命中
 *   是两回事，显示成 0 会让人以为缓存配置错了。
 * - 计价为 0 时不显示金额，而不是显示 $0.0000——未知计价冒充免费更误导。
 */
function RunStatusBar() {
  const u = () => state.usage
  const normal = () => state.stopReason === 'completed'
  return (
    <div class="run-status" classList={{ abnormal: !normal() }}>
      <span>{stopReasonLabel(state.stopReason!)}</span>
      <Show when={u()}>
        {(usage) => (
          <>
            <span class="dot">·</span>
            <span title="输入 / 输出 token">
              {usage().inputTokens.toLocaleString()} 入 / {usage().outputTokens.toLocaleString()} 出
            </span>
            <span class="dot">·</span>
            <span title="缓存命中 token">
              缓存{' '}
              {usage().cachedTokens === null ? '未回报' : usage().cachedTokens!.toLocaleString()}
            </span>
            <Show when={usage().costUsd > 0}>
              <span class="dot">·</span>
              <span>${usage().costUsd.toFixed(4)}</span>
            </Show>
          </>
        )}
      </Show>
    </div>
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
    if (phase === 'failed')
      return `上下文压缩失败${c()?.reasonCode ? `（${c()!.reasonCode}）` : ''}`
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

function ToolGroup(props: { members: TranscriptItem[] }) {
  const [open, setOpen] = createSignal(false)
  const tools = () => props.members.filter((m) => m.kind === 'tool')
  const running = () => tools().some((t) => t.status === 'running')
  const failed = () => tools().some((t) => t.status === 'failure')

  return (
    <div class="tool-group" classList={{ failed: failed() }}>
      <button class="tool-head" type="button" onClick={() => setOpen((v) => !v)}>
        <span class="tool-status">
          <Show
            when={running()}
            fallback={<IconChevron size={13} dir={open() ? 'down' : 'right'} />}
          >
            <IconSpinner size={14} />
          </Show>
        </span>
        <span class="tool-label">{groupTitle(props.members)}</span>
        <span class="tool-time">{tools().length}</span>
      </button>
      <Show when={open()}>
        <div class="tool-group-body">
          <For each={props.members}>
            {(m) => (
              <Show when={m.kind === 'tool'} fallback={<ThinkingFold item={m} />}>
                <ToolCard item={m} />
              </Show>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

function ToolCard(props: { item: TranscriptItem }) {
  const [open, setOpen] = createSignal(false)
  const Icon = () => toolIcon(props.item.toolName ?? '')
  const target = () => props.item.action?.target

  return (
    <div
      class="tool"
      classList={{
        failed: props.item.status === 'failure',
        superseded: props.item.superseded,
      }}
    >
      <button class="tool-head" type="button" onClick={() => setOpen((v) => !v)}>
        <span
          class="tool-status"
          classList={{
            ok: props.item.status === 'success',
            bad: props.item.status === 'failure',
          }}
        >
          <Switch>
            <Match when={props.item.status === 'running'}>
              <IconSpinner size={14} />
            </Match>
            <Match when={props.item.status === 'success'}>
              <IconCheck size={14} />
            </Match>
            <Match when={props.item.status === 'failure'}>
              <IconX size={14} />
            </Match>
          </Switch>
        </span>
        <span class="tool-icon">{Icon()({ size: 14 })}</span>
        <span class="tool-label">{actionLabel(props.item)}</span>
        <Show when={target()}>
          <code class="tool-target truncate">{target()}</code>
        </Show>
        <Show when={props.item.durationMs}>
          <span class="tool-time">{formatMs(props.item.durationMs!)}</span>
        </Show>
      </button>

      {/* 失败的卡默认展开：失败信息不该还要多点一下才看得到 */}
      <Show when={open() || props.item.status === 'failure'}>
        <div class="tool-body">
          <Show when={props.item.outcome}>
            <div class="tool-msg">{props.item.outcome!.message}</div>
          </Show>
          <Show when={props.item.stdout}>
            <pre class="tool-out">{props.item.stdout}</pre>
          </Show>
        </div>
      </Show>
    </div>
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
    no_api_key: '还没配 API Key。在配置文件里填 apiKey，或跑 qy init。',
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

function stopReasonLabel(reason: string): string {
  const map: Record<string, string> = {
    completed: '已完成',
    max_steps: '已达步数上限',
    user_interrupt: '已中断',
    permission_denied: '授权被拒绝，已停止',
    context_exhausted: '上下文超出模型窗口',
    output_truncated: '输出被截断，回答不完整',
    provider_error: '模型服务出错',
    internal_guard: '内部保护触发',
    budget_exceeded: '已超出预算',
  }
  return map[reason] ?? reason
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}
