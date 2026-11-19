import { definePort } from '@qywork/agent'
import type { FileChange } from '@qywork/core'

/**
 * 后台命令端口：`run_command` 结束等待而命令仍在运行时，命令交给装配方的进程级任务表持有。
 *
 * 任务表跨越多轮存在，回执经由会话的投递入口送达，二者都在 server，因此实现由 server 注入。
 * 端口按会话绑定，方法不带会话参数：其他会话的后台命令在此不可见。只注入顶层会话：
 * 回执须能发起该会话的一轮。
 *
 * 命令的启动、等待与收尾只在 `run_command` 中执行，任务表只持有转入后台之后的句柄：
 * 命令结束时先把转入后台之后的文件改动追加到 `stepId` 的 `outcome.fileChanges`，再投递回执；
 * 被停止的命令同样追加改动，不投递回执。
 *
 * 未注入时 `run_command` 没有 `background` 参数，前台等待不会提前结束，`background_command` 不注册。
 */
export interface CommandPort {
  /**
   * 本会话的投递队列中出现用户发来的「调整方向」消息（`FollowUp.steer` 为真且没有 `origin`）后兑现；
   * 已存在时立即兑现。`signal` 中止时以中止原因拒绝。信号来源与 `DelegatePort.awaitReceipt` 相同。
   */
  steered(signal: AbortSignal): Promise<void>
  /** 登记一条转入后台的命令，返回任务编号。登记之后本轮停止不再影响该命令。 */
  adopt(task: {
    command: string
    /** 发起该命令的 `run_command` 调用的 step。转入后台之后的文件改动归属它。 */
    stepId: string
    output(): CommandOutput
    /**
     * 标准输入。只有以 `background: true` 启动的命令才有；由前台转入后台的命令启动时没有输入管道，为 null。
     * `write` 在输入已关闭时返回 false，`end` 关闭输入。
     */
    input: { write(text: string): boolean; end(): void } | null
    /** 结束命令的进程树。之后 `settled` 兑现，`receipt` 为 null。 */
    stop(): void
    /**
     * 命令结束时兑现。`receipt` 是回执正文，被停止时为 null；`fileChanges` 是转入后台之后观察到的文件改动，
     * 两种结束方式都有。
     */
    settled: Promise<{ receipt: string | null; fileChanges: FileChange[] }>
  }): string
  /** 本会话正在后台运行的命令。 */
  list(): { id: string; command: string }[]
  /** 某条后台命令至今的输出。不在本会话的任务表中（已结束、已停止或编号有误）时为 null。 */
  output(id: string): ({ command: string } & CommandOutput) | null
  /** 停止某条后台命令，返回其命令文本；不在任务表中时为 null。被停止的命令不发送回执。 */
  stop(id: string): string | null
  /**
   * 向某条后台命令的标准输入写入 `text`，`end` 为真时随后关闭输入。命令没有输入管道时为 `no_input`，
   * 输入已关闭时为 `closed`；不在任务表中时为 null。
   */
  write(id: string, text: string, end: boolean): 'written' | 'no_input' | 'closed' | null
  /**
   * 某条后台命令结束并移出任务表后兑现：回执已进入投递队列时为 true，被停止而没有回执时为 false。
   * 不在任务表中时为 null。只报告结束，不返回回执内容：回执只经由队列送达。
   */
  ended(id: string): Promise<boolean> | null
}

export const CommandPort = definePort<CommandPort>('commands')

/** 后台命令至今保留的输出，已脱敏。每条流只保留最近的一段，`dropped` 是各流从头部丢弃的字符数。 */
export interface CommandOutput {
  stdout: string
  stderr: string
  dropped: { stdout: number; stderr: number }
}
