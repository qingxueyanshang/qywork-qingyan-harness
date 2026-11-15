import type { RunUsage, StopReason } from '@qywork/core'
import { formatCosts, runCosts } from '@qywork/core'
import { Show } from 'solid-js'
import { compact, hitRate, stopReasonLabel } from '../../../lib/step-view.ts'

/**
 * Run 收尾条：停止原因、实际用量与耗时，每轮一条。
 *
 * 数据由 props 传入，而不是读取运行中的 view：读取 `ConversationView.usage` /
 * `runStartedAt` 等会话级字段时，整个会话只有一条，第二轮执行完毕会覆盖第一轮的读数，
 * 刷新后一条也不保留。这些数字逐轮保存在 `runs` 表中，每轮一个条目、由投影层从 run 行重建。
 *
 * 执行完毕的轮次由 `RunCard` 传入 run 行的字段；运行中的轮次没有 run 行可读，
 * 由 `<LiveRunBar />` 读取实时状态渲染同一外壳。
 *
 * 必须遵守三条口径：
 * - 正常完成不另外显示「已完成」；只有异常停止与错误正文占用该字段。
 * - 缓存命中未知或未报告时都显示 `N/A`；provider 明确报告 0 时才显示 0。
 *   只取最后一次调用，不以上一轮的数值填补当前缺失。
 * - 计价为 0 时不显示金额，不显示 $0.0000：把未知计价显示为免费更具误导性。
 */
export function RunStatusBar(props: {
  usage: RunUsage | null
  stopReason: StopReason | null
  /** 单位为秒。null 表示没有可信的起止时刻，不显示该字段。 */
  elapsed: number | null
  running: boolean
  /**
   * 运行时该字段显示的内容。
   *
   * 由调用方传入而不在此处计算：静默判定需要按当前时刻计算，而只有 `LiveRunBar`
   * 持有逐秒更新的定时器；在此处读取 `Date.now()` 时，界面不会自动更新。
   */
  liveNote?: string
  /** 错误正文或停止依据（`stopDetail`），没有时为 null。显示时它替代停止原因，而不是与停止原因并列显示。 */
  errorMessage?: string | null
}) {
  const normal = () => !props.stopReason || props.stopReason === 'completed'
  /**
   * 停止原因的文字。
   *
   * 有错误正文时显示正文：「模型服务出错」只说明了出错方，而「网络不可达：检查接口
   * 地址与代理」说明了下一步操作；两句同时显示即为重复，且该字段位于读数条末位，
   * 用途就是说明停止原因。
   *
   * 正文在读数条中单行显示、超出部分省略，悬停提示显示全文。读数条只有一行，整段换行显示会撑高该行；
   * 而报错的后半段（对端原文、故障编号、request id）在其他位置都看不到，不能只取首行。
   *
   * 以等待用户回复或完成结束的一轮，正文是待办中受阻项的条件与失败项的原因（`agent/loop/turn-end.ts` 的 `stopDetail`），
   * 待办清单每一行下方已显示同一内容：读数条不显示该正文，等待用户回复只显示停止原因的名称，完成不显示。
   */
  const detail = () =>
    props.stopReason === 'awaiting_user' || props.stopReason === 'completed'
      ? null
      : props.errorMessage?.trim() || null
  const reason = () => detail() ?? (props.stopReason ? stopReasonLabel(props.stopReason) : null)
  const showReason = () =>
    !props.running && Boolean(reason()) && (props.stopReason !== 'completed' || Boolean(detail()))

  return (
    <div class="run-strip" classList={{ done: !props.running, abnormal: !normal() }}>
      {/* 运行指示条：运行时星点流动、五段依次提亮，执行完毕后暂停动画并降低亮度。
          「运行中」与「已执行完毕」必须在视野边缘即可区分，仅靠文字变化无法做到。
          五段分别编写：每段各有一条错开延时的动画与各自的星点数。 */}
      <span class="run-galaxy" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
        <span />
      </span>

      <span class="run-readout">
        {/* 本轮开始的确认到达前保留耗时列，避免确认到达时后续读数发生位移。 */}
        <Show when={props.running || props.elapsed !== null}>
          <span
            class="run-metric run-elapsed"
            data-tip={props.elapsed === null ? undefined : '本轮耗时'}
            aria-hidden={props.elapsed === null}
          >
            {props.elapsed === null ? '' : `${props.elapsed.toFixed(1)}s`}
          </span>
        </Show>
        <Show when={props.usage}>
          {(usage) => (
            <>
              <span class="run-metric" data-tip="输入 / 输出 token">
                ↓{compact(usage().inputTokens)} ↑{compact(usage().outputTokens)}
              </span>
              {/* 模型调用与生成的花费合并显示，不同币种并列。计价为 0 时不显示金额：把未知计价显示为免费更具误导性。 */}
              <Show when={Object.keys(runCosts(usage())).length > 0}>
                <span class="run-metric run-cost">{formatCosts(runCosts(usage()))}</span>
              </Show>
            </>
          )}
        </Show>
        {/* 模型在 usage 生成前报错时，同样必须明确显示为未知。
            口径（取最后一次调用、区分 null 与 0）只由 `hitRate` 维护。 */}
        <span class="run-metric" data-tip="最后一次模型调用的缓存命中占输入总量的比例">
          命中 {props.usage ? hitRate(props.usage) : 'N/A'}
        </span>
        {/*
         * 「正在思考…」等运行状态位于金额之后，与停止原因占用同一字段。
         *
         * 不要把它悬浮在输入区上方：那里没有预留位置，它出现与消失会推动整个输入框，
         * 即尺寸随内容变化。该字段的用途是显示本轮状态：运行时说明正在进行的操作，
         * 执行完毕后说明停止原因，位置与语义一致。
         */}
        <Show when={props.running && props.liveNote}>
          <span class="run-live" data-tip={props.liveNote}>
            {props.liveNote}
          </span>
        </Show>
        {/* 停止原因排在末位：它长度不定，排在最前会把后续读数整体右移，
            出错的轮次与正常轮次的列无法对齐。排在末位时，前面各字段的位置固定。 */}
        <Show when={showReason()}>
          <span class="run-reason" data-tip={detail() ?? undefined}>
            {reason()}
          </span>
        </Show>
      </span>
    </div>
  )
}
