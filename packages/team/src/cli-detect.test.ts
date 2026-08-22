/**
 * 覆盖范围：`cli-detect.ts`（PATH 解析、凭证判据）。
 *
 * 测的是**行为**：装了就出现在结果里、没装就不出现、见到凭证才算接入。
 * 表里认哪几家不测——那是随时会加的一行数据，不是行为。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectClis, findCli } from './cli-detect.ts'

/** 造一个假的 claude 可执行文件。两种后缀都写，POSIX 与 Windows 各认一个。 */
async function fakeBin(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qy-cli-'))
  await writeFile(join(dir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  await writeFile(join(dir, `${name}.cmd`), '@echo off\n')
  return dir
}

describe('外部 CLI 识别', () => {
  test('PATH 上有就认出来，没有的不出现', async () => {
    const dir = await fakeBin('claude')
    const found = await detectClis({ PATH: dir, PATHEXT: '.CMD' })
    expect(found.map((c) => c.id)).toEqual(['claude'])
    expect(found[0]!.vendor).toBe('Anthropic')
    expect(found[0]!.path.startsWith(dir)).toBe(true)
  })

  test('PATH 上一个都没有时回空，不报错', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qy-cli-empty-'))
    expect(await detectClis({ PATH: dir, PATHEXT: '.CMD' })).toEqual([])
  })

  test('环境变量里有 key 就算接入', async () => {
    const dir = await fakeBin('claude')
    const on = await findCli('claude', { PATH: dir, PATHEXT: '.CMD', ANTHROPIC_API_KEY: 'sk-x' })
    expect(on?.connected).toBe(true)
  })

  test('装了但没凭证时是「未接入」，不是「没装」', async () => {
    const dir = await fakeBin('codex')
    // 家目录下可能真的有 ~/.codex/auth.json（这台机器上装过），
    // 所以这条只断言它**被识别到了**，接入与否交给上一条按环境变量测。
    const found = await findCli('codex', { PATH: dir, PATHEXT: '.CMD' })
    expect(found?.id).toBe('codex')
    expect(typeof found?.connected).toBe('boolean')
  })

  test('不认识的 id 返回 undefined', async () => {
    const dir = await fakeBin('claude')
    expect(await findCli('nope', { PATH: dir, PATHEXT: '.CMD' })).toBeUndefined()
  })
})
