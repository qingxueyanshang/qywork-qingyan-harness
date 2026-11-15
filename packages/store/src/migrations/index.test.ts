/**
 * 迁移汇总的结构守卫。覆盖范围：`migrations/index.ts` 的 `MIGRATIONS` 与本目录中的迁移文件。
 *
 * 汇总数组与迁移文件一一对应：每个 `<id>-<name>.ts` 只导出一条迁移，其 id 与 name 与文件名一致；
 * 数组按 id 顺序恰好包含这些迁移。未在汇总文件中登记的迁移不会执行，且不产生任何报错。
 */

import { expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { MIGRATIONS } from './index.ts'
import type { Migration } from './shared.ts'

const MIGRATION_FILE = /^(\d{3})-([a-z0-9-]+)\.ts$/
const OTHER_FILES = new Set(['index.ts', 'index.test.ts', 'shared.ts'])

test('迁移的 id 从 1 起逐一递增', () => {
  expect(MIGRATIONS.map((m) => m.id)).toEqual(MIGRATIONS.map((_, i) => i + 1))
})

test('目录中的每个迁移文件都按 id 顺序登记在汇总数组中，没有遗漏或多余', async () => {
  const names = readdirSync(import.meta.dir).sort()
  expect(names.filter((n) => !OTHER_FILES.has(n) && !MIGRATION_FILE.test(n))).toEqual([])
  const loaded: Migration[] = []
  for (const file of names.filter((n) => MIGRATION_FILE.test(n))) {
    const [, id, name] = MIGRATION_FILE.exec(file)!
    const exported = Object.values(await import(join(import.meta.dir, file))) as Migration[]
    expect({ file, count: exported.length }).toEqual({ file, count: 1 })
    const migration = exported[0]!
    expect({ file, id: migration.id, name: migration.name }).toEqual({
      file,
      id: Number(id),
      name: name!.replaceAll('-', '_'),
    })
    loaded.push(migration)
  }
  expect(MIGRATIONS.length).toBe(loaded.length)
  for (const [i, migration] of MIGRATIONS.entries()) expect(migration).toBe(loaded[i]!)
})
