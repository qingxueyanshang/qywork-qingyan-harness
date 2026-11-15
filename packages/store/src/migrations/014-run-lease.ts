import type { Migration } from './shared.ts'

export const migration014: Migration = {
  id: 14,
  name: 'run_lease',
  /**
   * run 记录**运行它的进程**，启动回收据此跳过仍在运行的 run。
   *
   * **这两列不可缺少。** `recoverStaleRuns` **不能不加区分地扫描全库的 running/queued**：同一台机器上
   * 可能有多个进程写同一个账本（两个工作区各一个 sidecar、开发环境的热重载、终端中的 `qy exec
   * `）。不加区分地扫描时，**后启动的进程会将前一个进程正在运行的轮次判定为中断**，而该进程仍在
   * 运行、仍在写入。实测记录：一个执行了 40 步的 run 在第 27 次请求发出后 257 毫秒被判定为中断，写
   * 入者是另一个刚启动的进程。
   *
   * 判定仍在运行需要两个信号，缺一不可：
   *
   * - `owner_pid`：进程已退出即应回收，此保证不能弱化。
   *   仅有 pid 不够：Windows 会复用 pid，无关的新进程占用同一编号时，
   *   已结束的 run 将始终被判定为运行中，会话被永久锁定。
   * - `heartbeat_at`：运行中的进程每十秒更新一次。pid 被复用（或进程仍在
   *   但该轮已废弃）时，心跳停止更新，超时即回收。
   *
   * 仅有心跳同样不够：进程崩溃后立即重启时，心跳仅过去两秒，按超时判定仍在运行，
   * 该 run 因此不会被回收，而它已没有任何进程在运行，会话随之锁定。
   * **两个信号分别覆盖对方的缺口，因此两列都需要。**
   *
   * 可空：迁移之前的历史行没有归属，按无归属处理，照常回收。
   */
  sql: `
ALTER TABLE runs ADD COLUMN owner_pid INTEGER;
ALTER TABLE runs ADD COLUMN heartbeat_at INTEGER;
`,
}
