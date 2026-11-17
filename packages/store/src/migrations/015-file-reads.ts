import type { Migration } from './shared.ts'

export const migration015: Migration = {
  id: 15,
  name: 'file_reads',
  /**
   * 「写入前必须先读取」的读取记录从进程内存移入账本，按**会话**归属。
   *
   * **不能存放在 `ToolContext.state` 上。** 该 map 只在 **run 内有效**（投递额度、计划快照也存放其
   * 中，前者每次决策重置），存入其中时读取记录每轮清零：模型上一轮读取过、本轮直接修改，
   * 必然先失败一次「本轮未读取过」，补充一次 read 后才能修改。
   *
   * 服务端**每条消息新建一个 Session**（见 `run-control.ts` 的注释），
   * 因此进程中没有会话级的生命周期可用。账本中有：每个会话是一行，
   * 删除会话时这些行随 `ON DELETE CASCADE` 一并删除，无需另设淘汰策略。
   * 上下文面板基于同一理由改为从账本实时计算（`runtime/context-panel.ts`）。
   *
   * **该守卫负责新鲜度，不负责记忆。** 存储的是**整份文件内容的哈希**，部分读取（offset/limit）也记录
   * 全量哈希，因此它不保证模型已读取全文，只判定待写入的文件是否与读取时一致。
   * 新鲜度以磁盘当前内容为准，与 run 边界无关，因此延长生命周期不放宽任何约束：文件被他人修改后同样
   * 会被拦截，拦截依据是哈希比对。
   *
   * 主键 (conversation_id, path)：同一文件重复读取时覆盖，只保留最近一次。
   * `path` 存储**解析后的绝对路径**，与内存中的键一致；模型写的相对路径
   * 形态不唯一（`js/a.js` / `./js/a.js`），以它为键会遗漏。
   */
  sql: `
CREATE TABLE file_reads (
  conversation_id TEXT    NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  path            TEXT    NOT NULL,
  hash            TEXT    NOT NULL,
  read_at         INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, path)
);
`,
}
