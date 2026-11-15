import type { Migration } from './shared.ts'

export const migration067: Migration = {
  id: 67,
  name: 'provider_request_configuration',
  sql: `ALTER TABLE provider_requests ADD COLUMN configuration TEXT;`,
}
