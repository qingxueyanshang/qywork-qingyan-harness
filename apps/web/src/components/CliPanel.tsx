/**
 * 右侧面板里的外部 CLI 页：看一个 CLI 节点此刻在写什么。
 *
 * **不是终端**：这里不能输入，也就不能在里面 Ctrl-C——被调度的 CLI 是以打印模式跑的
 * （`cli-detect.ts` 的厂商表），没有可交互的那一端。要停一个跑飞的 CLI，
 * 用这一轮的停止按钮，它是树杀。
 *
 * **也不用 xterm**：那一包三百多 K，而这里的字节里没有 ANSI——`cli-backend.ts`
 * 起进程时给的是 `NO_COLOR=1` / `TERM=dumb`。
 */

import { Show } from 'solid-js'
import { state } from '../lib/store/index.ts'
import { tabCliNode } from '../lib/store/ui.ts'

export default function CliPanel(props: { id: string }) {
  const where = () => tabCliNode(props.id)
  const card = () => state.transcript.find((t) => t.id === where().stepId)

  /**
   * 活着的时候是攒起来的中途输出，跑完 / 刷新之后是落库的那段终态产出。
   *
   * 两条各管一段，不互相兜底：中途输出不落库（`team.output` 与 `team.member` 同一条
   * 口径），而终态产出只有跑完才有。
   */
  const body = () => {
    const live = card()?.nodes?.find((n) => n.nodeId === where().nodeId)?.output
    if (live) return live
    const back = (
      card()?.outcome?.data as { nodes?: { nodeId: string; output?: string }[] } | undefined
    )?.nodes?.find((n) => n.nodeId === where().nodeId)
    return back?.output ?? ''
  }

  return (
    <div class="cli-pane">
      <Show when={body()}>
        <pre class="cli-out">{body()}</pre>
      </Show>
    </div>
  )
}
