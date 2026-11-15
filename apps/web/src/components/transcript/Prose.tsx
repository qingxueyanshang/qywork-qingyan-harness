import { createEffect, createMemo, createSignal, untrack, useContext } from 'solid-js'
import { createStreamRenderer, renderMarkdown } from '../../lib/markdown.ts'
import type { TranscriptItem } from '../../lib/store/index.ts'
import { reparseSkip } from '../../lib/stream-pace.ts'
import { RowStream } from './row-stream.ts'

/**
 * assistant 正文。
 *
 * 只有运行中的最后一条按流式渲染（`createStreamRenderer`）；
 * 定稿后整段重新渲染一次，纠正增量解析的已知偏差。
 *
 * 不要在此处再加一层限速。正文写入 store 的节奏已由 `stream-pace.ts` 确定：每 50ms 一档，
 * 每档按上游流速释放若干字符。在此之上再加一个定时器时，两级叠加的结果是：首次变化设置
 * 60ms 的 timer，期间的变化被合并，执行后 timer 清空，下一次变化再设置 60ms，稳态变为
 * 每 100ms 更新一次、每次包含两档的内容。20Hz 的匀速更新降为 10Hz 的跳变，正文成批出现，
 * 而不是连续输出。
 *
 * DOM 只更新活动区。已定稿的块插入容器后不再修改，每档只删除其后的节点并重新插入活动区。
 * 不要把两个区各包一层 `<div>`：`transcript.css` 的 `.markdown > :first-child` /
 * `:last-child` / `p:last-child` 按容器的直接子元素编写，多包一层后这三条规则全部失效
 * （首尾外边距无法折叠，两个区之间出现多余间距）。
 *
 * 整段替换 `innerHTML` 的代价不止重建节点：33KB 的 HTML 实测 7.8ms、66KB 为 15.5ms
 * （2026-08-20，真实 Chromium），且流式输出期间用户选中的文字每档被清除一次，无法复制。
 */
export function Prose(props: { item: TranscriptItem }) {
  const row = useContext(RowStream)
  /*
   * 必须使用 memo，不能使用普通取值函数。
   *
   * 它读取的两个值都随本列增长而变化：该流是否在运行，以及末项 id。每追加一条
   * （每次工具启动、每条用户消息、每条收尾读数）两者都会通知一次，而 effect 依据
   * 依赖是否通知决定是否重新执行，不比较取值是否变化。使用普通取值函数时，会话中每一段
   * 已定稿的正文都会在每次追加时重新执行 `renderMarkdown` 并整段替换 innerHTML。
   * 逐帧实测（真实服务端与前端，两轮四步）：一段 80 个节点的正文定稿后又被整段
   * 重建 9 次，其中 5 次集中在收尾的同一毫秒内。memo 按值去重，只在从流式转为定稿时通知。
   */
  const streaming = createMemo(() => row.live() && row.items().at(-1)?.id === props.item.id)

  // 重新解析的频率由 `reparseSkip` 决定，判据与理由见该函数。
  const [gate, setGate] = createSignal(0)
  let sinceParse = 0
  let lastCost = 0

  createEffect(() => {
    const text = props.item.text
    if (!streaming()) {
      // 定稿时立即更新到全文，否则最后几档内容会一直停留在上一帧。
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
  /** 已定稿区占用的容器开头子节点数。活动区始终是其后的节点。 */
  let settledNodes = 0

  createEffect(() => {
    gate()
    /*
     * `streaming()` 必须被订阅，不能放入下方的 `untrack`。
     *
     * 定稿时文本长度通常不变：末档的文字在 `run.finished` 之前已写入 store，
     * 因此 `gate` 写入相同的值，信号不通知。只依赖 `gate` 时整段重新渲染不会发生，
     * 而增量渲染已知偏差的纠正依赖这次重新渲染。
     * `streaming()` 不会每档变化：它读取末项 id，向末项追加文本不改变 id。
     */
    const live = streaming()
    // 只依赖 `gate`：直接读取 text 会使该 effect 依赖 text，降频随之失效。
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
      // 内容经 markdown.ts 净化后才写入 DOM：模型输出不可信。
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
    <div class="row assistant">
      <div class="prose markdown" ref={host} />
    </div>
  )
}
