import type { Migration } from './shared.ts'

export const migration028: Migration = {
  id: 28,
  name: 'step_duration',
  /**
   * 将工具调用的执行时长写入数据库。
   *
   * 该值由 `agent/loop/tool-wave.ts` 测得（`Date.now()` 之差，随 `tool.finished` 发出），
   * 但只存在于连接期间：前端将其写入内存中的 item，刷新即丢失。因此派发任务卡上
   * 对应节点的耗时在刷新后消失；工作流图不受影响，其耗时由编排器单独测量，
   * 旧记录写在 `outcome.data.nodes[]`，转换后的 workflow 记录写在 `outcome.data.receipts[]`。
   *
   * **写入列，不写入 payload。** 耗时是该 step 的属性，不是工具结果的一部分；
   * 写入 `outcome.data` 会使其随结果进入模型上下文，而 `outcome.data` 是发给模型的内容。
   *
   * 与 `execution_started_at` 的分工：后者是进入执行器之前的时间戳，用于崩溃恢复
   * 判定不确定边界；本列是执行完成后的时长。两者并存，但**不要将两者相减**：
   * 前者在提交事务时写入，与执行器实际开始执行相差一次磁盘写入。
   *
   * 存量行为 NULL：这些调用确实发生过，但时长未写入数据库。界面在无值时不显示，
   * 不为其编造数值。
   */
  sql: `ALTER TABLE steps ADD COLUMN duration_ms INTEGER;`,
}
