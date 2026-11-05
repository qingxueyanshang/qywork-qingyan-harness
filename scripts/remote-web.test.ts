/**
 * 覆盖范围：`remote-web.ts` 的构建调度（首次构建立即返回目录且不通知换代、防抖合并、构建成功才通知换代、
 * 构建期间的变化在结束后再构建一次、失败时不通知且保留上一次产物）与 `pruneBuilds`。
 * 定时器为注入的模拟实现，构建为可手动完成的替身。
 */

import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRemoteWebBuilder, pruneBuilds } from './remote-web.ts'

function setup() {
  let timer: (() => void) | null = null
  let seq = 0
  const builds: { dir: string; finish: (ok: boolean) => void }[] = []
  const built: string[] = []
  const logs: string[] = []
  const builder = createRemoteWebBuilder({
    build: (dir) => new Promise<boolean>((finish) => builds.push({ dir, finish })),
    nextDir: () => `b/${++seq}`,
    onBuilt: (dir) => built.push(dir),
    debounceMs: 300,
    setTimer: (fn) => {
      timer = fn
      return fn
    },
    clearTimer: () => {
      timer = null
    },
    log: (line) => logs.push(line),
  })
  const fire = () => {
    const fn = timer
    timer = null
    fn?.()
  }
  return { builder, builds, built, logs, fire, pending: () => timer !== null }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

test('首次构建立即返回目录供 sidecar 使用，在后台构建，完成后不通知换代', async () => {
  const s = setup()
  expect(s.builder.start()).toBe('b/1')
  expect(s.builder.current()).toBe('b/1')
  expect(s.builds.map((b) => b.dir)).toEqual(['b/1'])
  s.builds[0]?.finish(true)
  await settle()
  expect(s.built).toEqual([])
})

test('连续变化合并为一次构建，成功后通知换代并记为当前产物', async () => {
  const s = setup()
  s.builder.start()
  s.builds[0]?.finish(true)
  await settle()
  s.builder.changed()
  s.builder.changed()
  expect(s.builds).toHaveLength(1)
  s.fire()
  await settle()
  expect(s.builds).toHaveLength(2)
  s.builds[1]?.finish(true)
  await settle()
  expect(s.built).toEqual(['b/2'])
  expect(s.builder.current()).toBe('b/2')
})

test('构建期间的变化在本次结束后再构建一次，不并发构建', async () => {
  const s = setup()
  s.builder.start()
  s.builder.changed()
  s.builder.changed()
  expect(s.pending()).toBe(false)
  expect(s.builds).toHaveLength(1)
  s.builds[0]?.finish(true)
  await settle()
  expect(s.builds).toHaveLength(2)
  s.builds[1]?.finish(true)
  await settle()
  expect(s.built).toEqual(['b/2'])
  expect(s.builder.current()).toBe('b/2')
})

test('构建失败时不通知换代、保留上一次产物，下一次变化重新构建', async () => {
  const s = setup()
  s.builder.start()
  s.builds[0]?.finish(true)
  await settle()
  s.builder.changed()
  s.fire()
  await settle()
  s.builds[1]?.finish(false)
  await settle()
  expect(s.built).toEqual([])
  expect(s.builder.current()).toBe('b/1')
  expect(s.logs).toHaveLength(1)
  s.builder.changed()
  s.fire()
  await settle()
  s.builds[2]?.finish(true)
  await settle()
  expect(s.built).toEqual(['b/3'])
  expect(s.builder.current()).toBe('b/3')
})

test('pruneBuilds 只删除序号小于保留目录的构建，其余条目不动', () => {
  const root = mkdtempSync(join(tmpdir(), 'qywork-remote-web-'))
  try {
    for (const name of ['1', '2', '3', 'other']) mkdirSync(join(root, name))
    pruneBuilds(root, '2')
    expect(readdirSync(root).sort()).toEqual(['2', '3', 'other'])
    expect(existsSync(join(root, '1'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
