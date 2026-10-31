/** 输入区工具栏的上下文占用读数，以及点开后的占用构成浮层。 */

import type { ContextGroup } from '@qywork/core'
import { CONTEXT_GROUPS } from '@qywork/core'
import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js'
import { explainApiError, state } from '../lib/store/index.ts'

/** 分组行的中文名称。键与 `CONTEXT_GROUPS` 一一对应，顺序由后者决定。 */
const GROUP_LABEL: Record<ContextGroup, string> = {
  historyMessages: '历史消息',
  executionRecords: '执行记录',
  intermediateContent: '工具结果',
  systemTools: '系统工具',
  mcpTools: 'MCP工具',
  systemPrompt: '系统提示词',
  memory: '记忆内容',
  skills: '技能清单',
  summary: '会话摘要',
  workspaceState: '工作区与状态',
}

/**
 * 分段颜色。按行序取色，不按值取色：颜色需要与标签绑定，
 * 用户再次打开时同一颜色仍对应同一类目。
 */
const SEG_COLOR = [
  '#6366f1',
  '#8b5cf6',
  '#a855f7',
  '#ec4899',
  '#f43f5e',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#14b8a6',
  '#0ea5e9',
  '#cbd5e1',
]

/** 紧凑记法：823 / 19.7k / 916.3k / 1M。数字用于快速比较大小，无需精确到个位。 */
function fmtTok(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

function fmtLimit(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

/**
 * 占用环。
 *
 * 数字用于读取数值，环用于快速判断占用程度，这是它与「5.2%」的分工。
 *
 * 两处细节由具体图形决定：
 * - **端点使用平头（默认 butt），不使用 round。** 圆头端点在 0% 时会绘制出一个小圆点，
 *   而新会话恒为 0%，该圆点看起来像已经占用了一小段。
 * - **从 -90° 开始绘制**，自十二点方向顺时针。不旋转时 SVG 从三点方向开始，
 *   低占用时那一小段位于右侧中部，无法看出是「刚开始」。
 */
function ContextRing(props: { percent: number }) {
  const CIRC = 2 * Math.PI * 6
  const offset = () => CIRC * (1 - Math.min(100, Math.max(0, props.percent)) / 100)
  return (
    <svg class="ctx-ring" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <circle class="ctx-ring-track" cx="8" cy="8" r="6" fill="none" stroke-width="3.2" />
      <circle
        class="ctx-ring-fill"
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke-width="3.2"
        stroke-dasharray={String(CIRC)}
        stroke-dashoffset={String(offset())}
        transform="rotate(-90 8 8)"
      />
    </svg>
  )
}

/**
 * 上下文占用。
 *
 * 点开后查看占用的构成：单独的「87%」无法据以操作，用户无法判断应压缩、
 * 删除记忆，还是更换上下文窗口更大的模型。
 *
 * **行集与行序固定，零值也显示：不得 `filter(n > 0)`，也不得按值排序。** 若行随值出现、消失或换
 * 位置，用户每次打开都需要重新查找关注的行；行数一变，浮层高度也随之变化（违反 B9）。
 * 按 `CONTEXT_GROUPS` 定序，十行始终存在，末尾固定为剩余空间。
 *
 * **「省略上下文」只在确实有省略时出现。** 它回答「哪些内容被移除」。压缩之前恒为 0，此时整段不渲染：
 * 恒为零的区块是噪声，而不是信息。
 */
export function ContextMeter() {
  const [open, setOpen] = createSignal(false)

  /*
   * 点击外部时关闭。判据使用 `.ctx-wrap`（含按钮）而不是 `.ctx-pop`：`pointerdown` 先于
   * `click` 触发，若只判断浮层，点击按钮会先关闭一次，按钮自身的 click 又将其打开，浮层无法关闭。
   */
  createEffect(() => {
    if (!open()) return
    const onDown = (e: Event) => {
      if (!(e.target as HTMLElement | null)?.closest?.('.ctx-wrap')) setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    onCleanup(() => {
      window.removeEventListener('pointerdown', onDown)
    })
  })

  const rows = () => {
    const c = state.context
    if (!c) return []
    const list = CONTEXT_GROUPS.map((key, i) => ({
      key: key as string,
      label: GROUP_LABEL[key],
      tokens: c.breakdown[key],
      color: SEG_COLOR[i] ?? '#cbd5e1',
    }))
    list.push({
      key: 'freeSpace',
      label: '剩余空间',
      tokens: Math.max(0, c.limit - c.tokens),
      color: SEG_COLOR[SEG_COLOR.length - 1]!,
    })
    return list
  }

  const omittedRows = () => {
    const o = state.context?.omitted
    if (!o) return []
    return [
      { key: 'historyOriginal', label: '历史消息原文', tokens: o.historyOriginal },
      { key: 'intermediateOriginal', label: '工具结果原文', tokens: o.intermediateOriginal },
    ].filter((r) => r.tokens > 0)
  }

  return (
    <Show
      when={state.context}
      fallback={
        // 读取失败时显示 N/A，原因在悬停提示中；不显示时读数整体消失，用户看不到原因。
        <Show when={state.contextError}>
          {(e) => (
            <span class="ctx-wrap">
              <span class="ctx-meter" data-tip={explainApiError(e(), '上下文占用读取失败')}>
                <ContextRing percent={0} />
                <span class="ctx-meter-num">N/A</span>
              </span>
            </span>
          )}
        </Show>
      }
    >
      {(c) => (
        <span class="ctx-wrap">
          <button
            class="ctx-meter"
            classList={{ warn: c().percent > 75 }}
            type="button"
            aria-expanded={open()}
            data-tip={`${c().tokens.toLocaleString()} / ${c().limit.toLocaleString()} tokens`}
            onClick={() => setOpen((v) => !v)}
          >
            <ContextRing percent={c().percent} />
            <span class="ctx-meter-num">{c().percent}%</span>
          </button>
          <Show when={open()}>
            <div class="ctx-pop" role="dialog" aria-label="上下文占用明细">
              <div class="ctx-head">
                <span>
                  上下文
                  {c().source === 'estimated'
                    ? '（估算）'
                    : c().source === 'projected'
                      ? '（含估算）'
                      : ''}
                </span>
                <span class="ctx-head-nums">
                  {fmtTok(c().tokens)} / {fmtLimit(c().limit)}
                </span>
              </div>
              <div class="ctx-stack" role="img" aria-label="上下文占用占比条">
                <For each={rows()}>
                  {(r) => (
                    <Show when={r.tokens > 0}>
                      <span
                        class="ctx-stack-seg"
                        style={{
                          width: `${Math.min(100, (r.tokens / Math.max(1, c().limit)) * 100)}%`,
                          background: r.color,
                        }}
                      />
                    </Show>
                  )}
                </For>
              </div>
              <ul class="ctx-rows">
                <For each={rows()}>
                  {(r) => (
                    <li class="ctx-row">
                      <span class="ctx-dot" style={{ background: r.color }} />
                      <span class="ctx-name">{r.label}</span>
                      <span class="ctx-num">{fmtTok(r.tokens)}</span>
                      <span class="ctx-pct">
                        {((r.tokens / Math.max(1, c().limit)) * 100).toFixed(1)}%
                      </span>
                    </li>
                  )}
                </For>
              </ul>
              <Show when={omittedRows().length > 0}>
                <div class="ctx-omitted">
                  <div class="ctx-subtitle">省略上下文</div>
                  <ul class="ctx-rows">
                    <For each={omittedRows()}>
                      {(r) => (
                        <li class="ctx-row">
                          <span class="ctx-dot ctx-dot-hollow" />
                          <span class="ctx-name">{r.label}</span>
                          <span class="ctx-num">{fmtTok(r.tokens)}</span>
                          <span class="ctx-pct">
                            {((r.tokens / Math.max(1, c().limit)) * 100).toFixed(1)}%
                          </span>
                        </li>
                      )}
                    </For>
                  </ul>
                </div>
              </Show>
            </div>
          </Show>
        </span>
      )}
    </Show>
  )
}
