/**
 * 右侧面板里的外部 CLI 页：跑着的时候看它在写什么，跑完看它的回执。
 *
 * **不是终端**：这里不能输入，也就不能在里面 Ctrl-C——被调度的 CLI 是以打印模式跑的
 * （`cli-detect.ts` 的厂商表），没有可交互的那一端。要停一个跑飞的 CLI，
 * 用这一轮的停止按钮，它是树杀。
 *
 * **也不用 xterm**：那一包三百多 K，而这里的字节里没有 ANSI——`cli-backend.ts`
 * 起进程时给的是 `NO_COLOR=1` / `TERM=dumb`。
 */

import type { FileChange } from '@qywork/core'
import { Show } from 'solid-js'
import { state } from '../lib/store/index.ts'
import { tabCliNode } from '../lib/store/ui.ts'
import { ChangeList } from './ChangeList.tsx'

interface Landed {
  nodeId: string
  output?: string
  changes?: FileChange[]
  changedTotal?: number
}

export default function CliPanel(props: { id: string }) {
  const where = () => tabCliNode(props.id)
  const card = () => state.transcript.find((t) => t.id === where().stepId)

  /** 跑着的时候攒起来的中途输出。**不落库**，刷新之后这里是空的。 */
  const live = () => card()?.nodes?.find((n) => n.nodeId === where().nodeId)?.output

  /**
   * 落库的那一份：它的产出（按约定，尾节是它自己写的回执）与量出来的改动清单。
   *
   * 中途输出不落库，所以刷新之后能说的只有这一份——**它是回执不是过程**，
   * 两者答的不是同一个问题。
   */
  const landed = () =>
    (card()?.outcome?.data as { nodes?: Landed[] } | undefined)?.nodes?.find(
      (n) => n.nodeId === where().nodeId,
    )

  return (
    <div class="cli-pane">
      <Show when={live()} fallback={<Receipt landed={landed()} />}>
        <pre class="cli-out">{live()}</pre>
      </Show>
    </div>
  )
}

function Receipt(props: { landed: Landed | undefined }) {
  return (
    <>
      <Show when={props.landed?.changes?.length}>
        <ChangeList
          changes={props.landed!.changes!}
          {...(props.landed?.changedTotal !== undefined
            ? { total: props.landed.changedTotal }
            : {})}
        />
      </Show>
      <Show when={props.landed?.output}>
        <pre class="cli-out">{props.landed!.output}</pre>
      </Show>
    </>
  )
}
