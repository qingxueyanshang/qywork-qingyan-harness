/**
 * 流式增量的缓冲：正文经节拍器匀速输出，思考、工具输出与 CLI 节点输出经合帧器按帧合并写入 transcript。
 * 编排逻辑位于 `stream-pace.ts`（可单独测试），此处只负责接线。
 *
 * 正文缓冲区中始终只有当前末尾的 text step：任何写入 transcript 的事件都先 `flushPace` 一次，
 * 因此无需按 step 区分缓冲。
 */

import { produce } from 'solid-js/store'
import { createFramer, createPacer } from '../../stream-pace.ts'
import { setState } from '../state.ts'

/**
 * 节拍器与合帧器的缓冲键：以会话 id 开头。
 *
 * 当前会话与右侧的子会话页同时接收增量，只按 stepId 区分时，两条会话的
 * step id 冲突会把文字写入另一条会话的正文。
 */
const SEP = String.fromCharCode(0)
const bufKey = (cid: string, ...rest: string[]): string => [cid, ...rest].join(SEP)

const schedule = (fn: () => void, ms: number) => {
  const t = setInterval(fn, ms)
  return () => clearInterval(t)
}

function writeTail(key: string, chunk: string): void {
  if (!chunk) return
  const [cid, stepId] = key.split(SEP) as [string, string]
  setState(
    produce((s) => {
      const items = s.views[cid]?.transcript
      if (!items) return
      const last = items[items.length - 1]
      // 同一个 text step 持续追加：只修改该字段，只更新一个文本节点。
      if (last?.kind === 'text' && last.id === stepId) last.text += chunk
      else items.push({ id: stepId, kind: 'text', text: chunk })
    }),
  )
}

const pacer = createPacer({ write: writeTail, schedule, now: () => Date.now() })

/**
 * 将工具执行过程中的输出写入对应卡片。
 *
 * 只保留末尾：一次构建可能输出数万行，全部保存会使内存占用与渲染开销不可接受。
 * 截断在合帧之后执行：按到达逐段截断会使同一份文本反复重排。
 */
function appendStdout(key: string, chunk: string): void {
  const [cid, stepId] = key.split(SEP) as [string, string]
  setState(
    produce((s) => {
      const item = s.views[cid]?.transcript.find((t) => t.id === stepId)
      if (!item) return
      const next = (item.stdout ?? '') + chunk
      item.stdout = next.length > 8000 ? next.slice(-8000) : next
    }),
  )
}

const toolFrames = createFramer({ write: appendStdout, schedule })

/**
 * 外部 CLI 节点执行过程中的输出，累积在该节点自身上。
 *
 * 键由会话、卡片、节点三段组成：一张图中可以有多个 CLI 节点同时运行，
 * 只按卡片区分时它们的输出会混为一段，无法区分来源。
 */
function appendNodeOutput(key: string, chunk: string): void {
  const [cid, stepId, nodeId] = key.split(SEP)
  setState(
    produce((s) => {
      const card = s.views[cid ?? '']?.transcript.find((t) => t.id === stepId)
      if (!card || !nodeId) return
      const next = (card.cliOutput?.[nodeId] ?? '') + chunk
      // 与工具卡的 stdout 使用同一上限：更多内容无法阅读，只会增加内存与渲染开销。
      card.cliOutput = {
        ...(card.cliOutput ?? {}),
        [nodeId]: next.length > 8000 ? next.slice(-8000) : next,
      }
    }),
  )
}
const nodeFrames = createFramer({ write: appendNodeOutput, schedule })

/**
 * 思考正文按 step 识别所属条目，不按「末项是否为思考」识别：同一次调用中出现第二段思考时，
 * 后者会把它合并进第一段，而两段是分别到达的。
 *
 * 使用合帧器而不逐条写入：思考 token 每秒数十到上百条，四条子会话流同时打开时每条都同步写入
 * store，标签预览、`<pre>` 重设、滚动到末尾各执行一遍，主线程被占满，其他页面的点击响应出现延迟。
 */
function appendThinking(key: string, chunk: string): void {
  const [cid, stepId] = key.split(SEP) as [string, string]
  setState(
    produce((s) => {
      const items = s.views[cid]?.transcript
      if (!items) return
      const last = items[items.length - 1]
      if (last?.kind === 'thinking' && last.id === stepId) last.text += chunk
      else items.push({ id: stepId, kind: 'thinking', text: chunk })
    }),
  )
}
const thinkFrames = createFramer({ write: appendThinking, schedule })

export function pushText(cid: string, stepId: string, delta: string): void {
  pacer.push(bufKey(cid, stepId), delta)
}

export function pushThinking(cid: string, stepId: string, delta: string): void {
  thinkFrames.push(bufKey(cid, stepId), delta)
}

export function pushToolOutput(cid: string, stepId: string, delta: string): void {
  toolFrames.push(bufKey(cid, stepId), delta)
}

export function pushNodeOutput(cid: string, stepId: string, nodeId: string, delta: string): void {
  nodeFrames.push(bufKey(cid, stepId, nodeId), delta)
}

export function flushText(): void {
  pacer.flush()
}

export function flushThinking(): void {
  thinkFrames.flush()
}

/** 立即写出全部缓冲。写入 transcript 的事件折叠之前调用，使界面内容完整。 */
export function flushPace(): void {
  pacer.flush()
  toolFrames.flush()
  nodeFrames.flush()
  thinkFrames.flush()
}

/** 丢弃积压内容。切换会话、整段重新获取时使用：积压文字的归属已不存在。 */
export function discardPace(): void {
  pacer.discard()
  toolFrames.discard()
  nodeFrames.discard()
  thinkFrames.discard()
}
