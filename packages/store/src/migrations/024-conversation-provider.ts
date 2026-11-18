import type { Migration } from './shared.ts'

export const migration024: Migration = {
  id: 24,
  name: 'conversation_provider',
  /**
   * 会话记录请求所用的接口。
   *
   * `model` 只是 ModelRef 的一半。另一半原由 `resolveModel` 临时推测：
   * 查找声明了该模型的接口，有多个时当前接口优先。两个第三方接口都提供
   * `claude-opus-5` 时该推测必有一半出错，后果是请求发往另一个端点、
   * 使用另一个 key、按另一份价目表记账，且三者都不报错。
   *
   * 空串表示本次迁移之前创建的会话，没有记录接口。迁移 37 按逐请求账本的唯一证据
   * 补齐；无法证明的保持空串并要求用户重新选择，不再按模型 id 推测。
   */
  sql: `ALTER TABLE conversations ADD COLUMN provider TEXT NOT NULL DEFAULT '';`,
}
