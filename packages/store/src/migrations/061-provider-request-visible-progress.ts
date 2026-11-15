import type { Migration } from './shared.ts'

export const migration061: Migration = {
  id: 61,
  name: 'provider_request_visible_progress',
  // 内容类别与可见时刻同属请求账本；不从旧行的首内容时刻推测可见进展。
  sql: `
ALTER TABLE provider_requests ADD COLUMN last_content_kind TEXT CHECK (last_content_kind IN ('thinking','text','tool_arguments','other'));
ALTER TABLE provider_requests ADD COLUMN last_visible_at INTEGER;
`,
}
