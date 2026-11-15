import type { Migration } from './shared.ts'

export const migration031: Migration = {
  id: 31,
  name: 'provider_error_message',
  /**
   * 请求被 provider 拒绝时，将其返回的错误原文保存在逐请求账本中。
   *
   * `error_code` 是本仓库归一化后的分类，只能说明错误类别；限速响应中能够
   * 定位账号、端点或上游策略的正文此前只存在于异常对象中，进程结束即丢失。它也
   * 不能写入 `runs.error_message` 代替本列：一个 run 可以重发多次，每次请求各有
   * 自己的回执，真源必须仍是每个请求一行。
   *
   * NULL 表示 provider 未返回正文、请求在连接层失败，或本次迁移之前的存量行。
   */
  sql: `ALTER TABLE provider_requests ADD COLUMN error_message TEXT;`,
}
