/**
 * 右侧面板中的外部 CLI 页：运行期间显示其输出，执行完毕后显示其返回的产出。
 *
 * **不是终端**：此处不能输入，因此也无法按 Ctrl-C。被调度的 CLI 以非交互方式运行
 * （`cli-detect.ts` 的厂商表），没有可交互的输入端。要停止失控的 CLI，
 * 使用本轮的停止按钮，它按进程树终止。
 *
 * **也不使用 xterm**：该依赖包三百多 KB，而此处的输出不含 ANSI 控制序列：`cli-backend.ts`
 * 启动进程时设置了 `NO_COLOR=1` / `TERM=dumb`。
 */

import { Show } from 'solid-js'
import { collapseWorkflowItems } from '../lib/render-items.ts'
import { transcript } from '../lib/store/index.ts'
import { tabCliNode } from '../lib/store/ui.ts'

export default function CliPanel(props: { id: string }) {
  const where = () => tabCliNode(props.id)
  const card = () => {
    const items = transcript()
    // workflow 面板的 stepId 是稳定的 workflowId，而实时输出记录在最近一轮的真实 step 上。
    // 与主列表使用同一折叠逻辑，才能同时取得最近的运行中节点与累计回执。
    return collapseWorkflowItems(items).find((item) => item.id === where().stepId)
  }

  /**
   * 运行期间显示累积的中间输出，执行完毕或刷新之后显示已落库的产出。
   *
   * 两者各负责一个阶段，不互为后备：中间输出不落库（`team.output`），而产出只在执行完毕后才存在。
   */
  const body = () => {
    const live = card()?.cliOutput?.[where().nodeId]
    if (live) return live
    const data = card()?.outcome?.data as { output?: unknown } | undefined
    // 编排图的产出按节点分别落库；单次派发只有一个节点，产出位于结果顶层。
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
