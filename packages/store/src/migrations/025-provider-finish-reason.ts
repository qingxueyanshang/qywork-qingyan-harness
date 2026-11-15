import type { Migration } from './shared.ts'

export const migration025: Migration = {
  id: 25,
  name: 'provider_finish_reason',
  /**
   * 账本记录 provider 返回的**原始值**，并删除一个始终为假的标志位。
   *
   * 增加 `finish_reason`：`runs.stop_reason` 存储的是本仓库自定义的词表
   * （`completed` / `output_truncated` / …），是归一化之后的结论。
   * 因此模型正常结束（`stop`）与模型请求调用工具但未解析出任何调用
   * （`tool_calls` + 零调用）在账本中完全相同，事后无法区分。
   * 空串表示本次迁移之前的行，或流在取得 finish_reason 之前中断。
   *
   * 删除 `measurement_exact`：三种协议都不在热路径上实测 token，写入端是常量
   * `false`，读取后没有任何消费者。始终为假的能力位比不存在更有害：
   * 后续维护者会将其视为有效的能力位。真值始终由 `provider_*_tokens` 各列提供。
   */
  sql: `
ALTER TABLE provider_requests ADD COLUMN finish_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE provider_requests DROP COLUMN measurement_exact;
`,
}
