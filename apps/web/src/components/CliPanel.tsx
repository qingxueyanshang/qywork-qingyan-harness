/**
 * 右侧面板里的外部 CLI 页：跑着的时候看它在写什么，跑完看它交回来的那段。
 *
 * **不是终端**：这里不能输入，也就不能在里面 Ctrl-C——被调度的 CLI 是非交互跑的
 * （`cli-detect.ts` 的厂商表），没有可交互的那一端。要停一个失控的 CLI，
 * 用这一轮的停止按钮，它按进程树终止。
 *
 * **也不用 xterm**：那一包三百多 K，而这里的字节里没有 ANSI——`cli-backend.ts`
 * 起进程时给的是 `NO_COLOR=1` / `TERM=dumb`。
 */

import { Show } from 'solid-js'
import { collapseWorkflowItems } from '../lib/render-items.ts'
import { transcript } from '../lib/store/index.ts'
import { tabCliNode } from '../lib/store/ui.ts'

export default function CliPanel(props: { id: string }) {
  const where = () => tabCliNode(props.id)
  const card = () => {
    const items = transcript()
    // workflow 的面板 stepId 是稳定 workflowId，而实时输出落在最近一轮真实 step。
    // 与主列表走同一折叠，才能同时拿到最近 live 节点和累计回执。
    return collapseWorkflowItems(items).find((item) => item.id === where().stepId)
  }

  /**
   * 运行期间是攒起来的中途输出，跑完 / 刷新之后是落库的那段产出。
   *
   * 两条各管一段，不互相兜底：中途输出不落库（`team.output`），而产出只有跑完才有。
   */
  const body = () => {
    const live = card()?.cliOutput?.[where().nodeId]
    if (live) return live
    const data = card()?.outcome?.data as { output?: unknown } | undefined
    // 一张图的产出按节点分开落；派一件只有一格，产出就在结果顶层。
    if (card()?.toolName === 'workflow') {
      return card()?.workflow?.results[where().nodeId]?.output ?? ''
    }
    return typeof data?.output === 'string' ? data.output : ''
  }

  return (
    <div class="cli-pane">
      <Show when={body()}>
        <pre class="cli-out">{body()}</pre>
      </Show>
    </div>
  )
}
