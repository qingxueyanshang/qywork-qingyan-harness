import type { Migration } from './shared.ts'

export const migration059: Migration = {
  id: 59,
  name: 'provider_request_input_image_batch_id',
  /**
   * 本次输入实际完整携带的一批工具图片，值是产生该批调用的请求 id。
   * 它与 `steps.provider_batch_id` 含义不同：后者记录生成归属，
   * 本列记录输入事实。能力过滤与压缩都会移除图片、保留文字，因此一次成功的请求
   * 不能证明模型看到过图片。NULL 表示迁移前的旧行、本次未携带图片，或图片未完整
   * 进入请求体；不按时间回填。
   */
  sql: `ALTER TABLE provider_requests ADD COLUMN input_image_batch_id TEXT;`,
}
