import { retryAttemptText, retryCauseText } from '@qywork/core'
import { createEffect, createSignal, on, onCleanup, Show } from 'solid-js'
import { isConversationRunning, state, viewOf } from '../../../lib/store/index.ts'
import { RunStatusBar } from './RunStatusBar.tsx'

/**
 * 无新增内容超过该时长后，状态文字由「正在回复…」改为显示无新增内容的时长。
 *
 * 该值是保守取值，不是测量结果。账本中有整轮往返耗时的分布（p90 约 32 秒），
 * 但它衡量的是整轮，不是两个事件之间的间隔，不能用作间隔阈值。
 *
 * 取值偏大只推迟该提示出现的时间；静默期间「正在回复…」始终不属实，
 * 因此即使提示出现较晚，也必须替换该文字。
 */
const SILENT_MS = 30_000

/** 会话流的最后一项是进行中的压缩。 */
function compacting(conversationId: string): boolean {
  const items = viewOf(conversationId).transcript
  const last = items[items.length - 1]
  return last?.kind === 'compaction' && last.compaction?.phase === 'started'
}

/**
 * 本轮当前所处的阶段。
 *
 * 阶段只有一个来源：会话的当前请求投影（`store/state.ts` 的 `RequestProjection`）。
 * 实时事件与刷新快照按同一规则写入它，因此刷新前后该字段显示相同的文字。
 *
 * 该字段描述阶段，不描述动作。工具分组标题描述这一批工具的动作
 * （查询 / 读取 / 创建 / 修改 / 删除 / 运行 / 调用），两者粒度不同、内容不重复；
 * 动作词表中没有「执行」，两者不会冲突。
 *
 * 「正在执行」必须检查 `status`。只检查 `kind === 'tool'` 时，从工具执行完毕到模型返回响应的
 * 整段时间都显示「正在执行…」，而该时段最容易出错（实测一次连接中断发生在其后 262 秒内）。
 * 工具卡片有终态，据此判定：运行中表示正在执行，执行完毕表示正在等待响应。工具运行期间
 * 不显示静默时长：一次构建持续十分钟属于正常情况，且构建本身会输出 stdout。
 *
 * 等待时长按阶段取各自的起始时刻：已产出内容时取 `lastContentAt`，尚未产出内容时取
 * 该阶段的 `sentAt` / `headersAt`。把阶段等待显示为「无新增内容」，会对一次从未产出内容的
 * 请求报告一个不存在的内容间隔。缺少时刻时不显示秒数，不以页面加载时刻或首个内容时刻代替。
 */
function liveStatus(now: number, conversationId: string): string {
  const current = viewOf(conversationId)
  const items = current.transcript
  const last = items[items.length - 1]

  /*
   * 连接状态不是 ready 时，该字段不显示内容。
   *
   * 下方「已 N 秒…」的文字在字面上仍然成立，但会把服务端断开表述为响应缓慢：
   * 用户会继续等待，而此时服务端已不可用，停止按钮也无法生效。
   * 连接状态由顶部的连接横幅显示（含重试倒计时）；此处再显示一次即形成两份文案，
   * 日后会出现不一致。
   */
  if (state.connection !== 'ready') return ''
  // 压缩进行中由压缩卡片显示阶段与进度。此时没有对话请求，按请求投影会显示「正在请求…」。
  if (compacting(conversationId)) return ''
  if (last?.kind === 'tool' && last.status === 'running') return '正在执行…'

  const req = current.request
  if (!req) return '正在请求…'
  const waiting = (message: string): string =>
    req.attempt > 0
      ? [
          retryAttemptText(req),
          message,
          ...(req.retryReason ? [retryCauseText(req.retryReason)] : []),
        ].join(' · ')
      : message
  switch (req.phase) {
    case 'backoff': {
      if (req.backoffUntil === null) return waiting('等待重试…')
      // 倒计时仅用于显示：重发由服务端按同一截止时刻发起，前端在倒计时归零时不执行任何操作。
      return waiting(`等待重试，${Math.max(0, Math.ceil((req.backoffUntil - now) / 1000))} 秒后…`)
    }
    case 'sent':
    case 'headers': {
      const since = req.phase === 'sent' ? req.sentAt : req.headersAt
      if (since !== null && now - since >= SILENT_MS) {
        return waiting(`已 ${Math.round((now - since) / 1000)} 秒没有响应`)
      }
      if (req.phase === 'headers' || req.attempt > 0) return waiting('等待响应…')
      return '正在请求…'
    }
    case 'content': {
      if (req.lastContentAt !== null && now - req.lastContentAt >= SILENT_MS) {
        return waiting(`已 ${Math.round((now - req.lastContentAt) / 1000)} 秒无新增内容`)
      }
      // 上游仍在发送工具参数、长时间没有可见的新内容时，同样需要显示等待时长。
      // 旧快照中的请求没有 `lastVisibleAt`，不以首个内容时刻推测可见进展。
      const visibleSince = req.lastVisibleAt ?? req.headersAt ?? req.sentAt
      if (req.lastContentKind != null && visibleSince !== null && now - visibleSince >= SILENT_MS) {
        return waiting(`等待响应，已 ${Math.round((now - visibleSince) / 1000)} 秒无可见进展`)
      }
      // 内容类别取自请求投影；旧快照没有类别时，回退为按最后一条 transcript 判定。
      if (req.lastContentKind === 'tool_arguments' || req.lastContentKind === 'other')
        return waiting('等待响应…')
      if (req.lastContentKind === 'thinking') return '正在思考…'
      if (req.lastContentKind === 'text') return '正在回复…'
      if (current.generatingToolCall) return '等待响应…'
      if (last?.kind === 'thinking') return '正在思考…'
      if (last?.kind === 'text') return '正在回复…'
      return '等待响应…'
    }
  }
}

/**
 * 运行中的轮次。
 *
 * 只有它需要每 100ms 更新一次的计时器，因此单独成一层：执行完毕的条目不应
 * 各自持有定时器，数十轮的会话会产生数十个持续触发的 interval，
 * 每次触发都使整个会话流重新计算。
 *
 * 停止原因恒为 null：本轮尚未停止。
 */
export function LiveRunBar(props: { conversationId: string }) {
  const [now, setNow] = createSignal(Date.now())
  // 开始时刻到达时同步时钟，避免上一帧的 now 早于新的开始时刻。
  createEffect(
    on(
      [
        () => isConversationRunning(props.conversationId),
        () => viewOf(props.conversationId).runStartedAt,
      ],
      ([running]) => {
        setNow(Date.now())
        if (!running) return
        const t = setInterval(() => setNow(Date.now()), 100)
        onCleanup(() => clearInterval(t))
      },
    ),
  )

  const elapsed = () => {
    const from = viewOf(props.conversationId).runStartedAt
    return from === null ? null : (now() - from) / 1000
  }
  /*
   * 手动压缩占用会话但不是一轮对话：没有开始事件、没有用量，读数条只剩空的耗时与「命中 N/A」。
   * 此时只显示压缩卡片。轮次中的自动压缩照常显示读数条：耗时与用量属于本轮。
   */
  return (
    <Show when={!(compacting(props.conversationId) && elapsed() === null)}>
      <RunStatusBar
        usage={viewOf(props.conversationId).usage}
        stopReason={null}
        elapsed={elapsed()}
        running={true}
        liveNote={liveStatus(now(), props.conversationId)}
      />
    </Show>
  )
}
