/**
 * 转入后台的命令，按会话记录。
 *
 * 服务进程级，与 `SubagentRegistry`、`CanvasService` 同级：`run_command` 在每轮新建的 Session 中执行，
 * 命令转入后台之后不再归属任何一轮，本表持有它的句柄直到命令结束、被停止或服务退出。
 *
 * 本表只回答两个问题：某会话有哪些后台命令、停止时结束哪个进程树。它不参与忙态判定
 * （`RunManager.isBusy`）：停止会话不结束后台命令，界面上的停止按钮因此不能因后台命令而出现。
 * 命令结束时的回执经由会话的投递入口（`submitMessage`）进入同一条跟进队列，不另建队列。
 * 命令结束（含被停止）时，转入后台之后的文件改动追加到发起它的 step（`appendStepFileChanges`），
 * 先于回执投递：回执发起的一轮读取变更清单时改动已在账本中。
 *
 * 句柄只在进程内，不写入磁盘：服务退出时 `stopAll` 结束全部命令，此时改动的追加不保证完成。服务进程被
 * 直接终止时（桌面外壳退出即如此）`stopAll` 不会执行，由 runner 在父进程退出后终止尚未退出的命令
 * （`runner.ts` 的 `leave`）。Linux（WSL2）实测；Windows 上命令另随 runner 一并结束；macOS 未实测。
 */

import type { CommandPort } from '@qywork/agent'
import {
  type AgentEvent,
  type BackgroundCommand,
  type ConversationId,
  type FileChange,
  type FollowUp,
  log,
  type StepId,
} from '@qywork/core'
import { appendStepFileChanges, type Store } from '@qywork/store'
import type { RunManager } from '../runs.ts'

type Task = Parameters<CommandPort['adopt']>[0]

/** 单次等待队列变化的上限。队列每次变化都会唤醒等待，到期只是重新检查一次。 */
const RECHECK_MS = 60_000

export class CommandTaskTable {
  /** 外层键是会话 id，内层键是任务编号。 */
  private readonly byConversation = new Map<ConversationId, Map<string, Task>>()

  constructor(
    /** 发布某会话的后台命令快照（`commands.changed`）与追加的文件改动（`file.changed`），按会话过滤下发。 */
    private readonly publish: (event: AgentEvent, conversationId: ConversationId) => void,
    /** 账本：命令结束时把转入后台之后的文件改动追加到发起它的 step。 */
    private readonly store: Store,
  ) {}

  /**
   * 登记一条转入后台的命令，返回任务编号。命令结束时先追加文件改动，再移除并投递回执；回执为 null
   * （被停止）时只移除。`settled` 拒绝时投递一条写明原因的回执：不投递时模型无从得知该命令已结束。
   */
  adopt(conversationId: ConversationId, task: Task, deliver: (followUp: FollowUp) => void): string {
    const id = `cmd_${crypto.randomUUID().slice(0, 8)}`
    const table = this.byConversation.get(conversationId) ?? new Map<string, Task>()
    table.set(id, task)
    this.byConversation.set(conversationId, table)
    this.announce(conversationId)
    void task.settled
      .then(
        (end) => {
          this.record(conversationId, task.stepId, end.fileChanges)
          return end.receipt === null ? null : `[后台命令回执] 任务 ${id} 已结束：${end.receipt}`
        },
        (err: unknown) =>
          `[后台命令回执] 任务 ${id} 已结束，结果无法读取：${err instanceof Error ? err.message : String(err)}\n命令：${task.command}`,
      )
      .then((content) => {
        this.remove(conversationId, id)
        if (content !== null) {
          deliver({ id: `rc_${crypto.randomUUID()}`, content, steer: true, origin: 'command' })
        }
      })
    return id
  }

  /** 该会话正在后台运行的命令，按登记顺序。 */
  listOf(conversationId: ConversationId): BackgroundCommand[] {
    return [...(this.byConversation.get(conversationId) ?? new Map<string, Task>())].map(
      ([id, task]) => ({ id, command: task.command }),
    )
  }

  output(conversationId: ConversationId, id: string): ReturnType<CommandPort['output']> {
    const task = this.byConversation.get(conversationId)?.get(id)
    return task ? { command: task.command, ...task.output() } : null
  }

  /**
   * 结束该会话中一条后台命令的进程树，返回其命令文本；不在表中时返回 null。
   * 条目在命令退出后由 `adopt` 的收尾移除，不在此处删除：此刻进程可能尚未退出。
   */
  stop(conversationId: ConversationId, id: string): string | null {
    const task = this.byConversation.get(conversationId)?.get(id)
    if (!task) return null
    task.stop()
    return task.command
  }

  /** 服务退出：结束全部后台命令。被停止的命令不投递回执。 */
  stopAll(): void {
    for (const table of this.byConversation.values()) {
      for (const task of table.values()) task.stop()
    }
  }

  /**
   * 追加文件改动并发布 `file.changed`，使文件视图与已打开的变更面板重新读取。
   * 写入失败只记入日志，回执照常投递：服务退出时（`stopAll`）账本可能已关闭。
   */
  private record(conversationId: ConversationId, stepId: string, changes: FileChange[]): void {
    if (changes.length === 0) return
    let recorded: ReturnType<typeof appendStepFileChanges>
    try {
      recorded = appendStepFileChanges(this.store, stepId as StepId, changes)
    } catch (err) {
      log.error(
        'commands',
        `后台命令的文件改动未能写入账本：${err instanceof Error ? err.message : String(err)}`,
        {
          conversationId,
          stepId,
        },
      )
      return
    }
    if (recorded?.changes.length) {
      this.publish(
        { type: 'file.changed', runId: recorded.runId, changes: recorded.changes },
        conversationId,
      )
    }
  }

  private remove(conversationId: ConversationId, id: string): void {
    const table = this.byConversation.get(conversationId)
    if (!table?.delete(id)) return
    if (table.size === 0) this.byConversation.delete(conversationId)
    this.announce(conversationId)
  }

  /** 每个变更点（登记、移除）各发布一次完整快照。 */
  private announce(conversationId: ConversationId): void {
    this.publish(
      { type: 'commands.changed', conversationId, commands: this.listOf(conversationId) },
      conversationId,
    )
  }
}

/**
 * 某会话的后台命令端口，交给该会话每一轮的 Session。端口按会话绑定，方法不带会话参数，
 * 其他会话的后台命令因此不可见。
 *
 * `steered` 与 `DelegatePort.awaitReceipt` 读取同一个信号来源：`RunManager` 的跟进队列与其变化通知。
 * 判据是用户发来的「调整方向」消息（`steer` 为真且没有 `origin`）：回执同样以 `steer` 入队，
 * 回执到达不结束前台等待。
 */
export function commandPortOf(
  table: CommandTaskTable,
  runs: Pick<RunManager, 'queueOf' | 'changed'>,
  conversationId: ConversationId,
  deliver: (followUp: FollowUp) => void,
): CommandPort {
  return {
    async steered(signal) {
      for (;;) {
        if (runs.queueOf(conversationId).some((f) => f.steer && !f.origin)) return
        await runs.changed(conversationId, RECHECK_MS, signal)
      }
    },
    adopt: (task) => table.adopt(conversationId, task, deliver),
    list: () => table.listOf(conversationId),
    output: (id) => table.output(conversationId, id),
    stop: (id) => table.stop(conversationId, id),
  }
}
