import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './db.ts'
import { SCHEMA_VERSION } from './schema.ts'

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

test('库里有本程序不认识的迁移就拒绝打开，且不补跑任何迁移', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qywork-store-ahead-'))
  const path = join(dir, 'ledger.sqlite3')
  const raw = new Database(path, { create: true })
  raw.exec(
    'CREATE TABLE _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)',
  )
  raw
    .query('INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)')
    .run(SCHEMA_VERSION + 1, 'from_a_newer_build', 0)
  raw.close()

  try {
    expect(() => new Store({ path })).toThrow(String(SCHEMA_VERSION + 1))

    const after = new Database(path)
    const ids = after
      .query<{ id: number }, []>('SELECT id FROM _migrations ORDER BY id')
      .all()
      .map((r) => r.id)
    after.close()
    expect(ids).toEqual([SCHEMA_VERSION + 1])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('空库与已迁移到当前版本的库照常打开', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qywork-store-open-'))
  const path = join(dir, 'ledger.sqlite3')
  try {
    const first = new Store({ path })
    first.close()
    const again = new Store({ path })
    const max = again.db
      .query<{ top: number }, []>('SELECT MAX(id) AS top FROM _migrations')
      .get()?.top
    again.close()
    expect(max).toBe(SCHEMA_VERSION)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
