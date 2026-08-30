import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './db.ts'

test('写事务在回调前取写权 —— 不从读事务升级后直接 SQLITE_BUSY', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qywork-store-tx-'))
  const path = join(dir, 'ledger.sqlite3')
  const store = new Store({ path })
  const other = new Database(path)

  try {
    store.db.exec('PRAGMA busy_timeout = 0')
    other.exec('BEGIN IMMEDIATE')
    let entered = false

    expect(() =>
      store.tx(() => {
        entered = true
      }),
    ).toThrow('database is locked')
    expect(entered).toBe(false)
  } finally {
    other.exec('ROLLBACK')
    other.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
