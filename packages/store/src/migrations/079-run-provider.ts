import type { Migration } from './shared.ts'

export const migration079: Migration = {
  id: 79,
  name: 'run_provider',
  /**
   * 轮次记录所用的接口，与 `model` 成对保存（`Run.provider`）。界面按「接口 × 模型」取得模型名称，
   * 只有 `model` 时只能按 id 推测接口。
   *
   * 旧行按逐请求账本补齐：该轮的请求只记录了一个接口名时写入该名称；没有请求或有多个接口名时保持空串，
   * 不以会话当前的接口推测历史归属。
   */
  sql: `
ALTER TABLE runs ADD COLUMN provider TEXT NOT NULL DEFAULT '';
UPDATE runs SET provider = (
  SELECT MIN(pr.provider_name) FROM provider_requests pr
  WHERE pr.run_id = runs.id AND trim(COALESCE(pr.provider_name, '')) <> ''
)
WHERE (
  SELECT COUNT(DISTINCT pr.provider_name) FROM provider_requests pr
  WHERE pr.run_id = runs.id AND trim(COALESCE(pr.provider_name, '')) <> ''
) = 1;
`,
}
