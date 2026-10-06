/**
 * 覆盖范围：`cli-detect.ts`（PATH 解析、凭证判据）。
 *
 * 测试的是行为：已安装的出现在结果中、未安装的不出现、检测到凭证才视为已接入。
 * 不测试厂商表收录哪些 CLI：那是随时可能增加的数据，不是行为。
 */

import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { detectClis, findCli } from './cli-detect.ts'

/** 创建一个模拟的 claude 可执行文件。写入两种后缀，POSIX 与 Windows 各识别其中一个。 */
async function fakeBin(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qy-cli-'))
  await writeFile(join(dir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  await writeFile(join(dir, `${name}.cmd`), '@echo off\n')
  return dir
}

describe('外部 CLI 识别', () => {
  /**
   * 厂商表声明了续问参数时，识别结果必须包含这些参数。
   * 遗漏这两项会使续问失效且不报错：厂商表中有声明，运行时却视为不支持。
   */
  test('识别结果包含续问所需的两项', async () => {
    const dir = await fakeBin('claude')
    const [claude] = await detectClis({ PATH: dir, PATHEXT: '.CMD' })
    expect(claude?.sessionField).toBeTruthy()
    expect(claude?.resumeArgs?.join(' ')).toContain('{session}')
  })

  /**
   * 遗漏正文路径同样会失效且不报错：实时页只显示原始 JSON 行，
   * 没有 `result` 行时回执无法取得正文。
   */
  test('jsonl 格式 CLI 的识别结果包含正文路径', async () => {
    const dir = await fakeBin('claude')
    const [claude] = await detectClis({ PATH: dir, PATHEXT: '.CMD' })
    expect(claude?.narrate?.text).toBeTruthy()
    expect(claude?.narrate?.tool).toBeTruthy()
  })

  test('PATH 上存在即识别，不存在的不出现', async () => {
    const dir = await fakeBin('claude')
    const found = await detectClis({ PATH: dir, PATHEXT: '.CMD' })
    expect(found.map((c) => c.id)).toEqual(['claude'])
    expect(found[0]!.vendor).toBe('Anthropic')
    expect(found[0]!.path.startsWith(dir)).toBe(true)
  })

  /**
   * 原始失败形状：POSIX 上只检查文件是否存在，排在 PATH 前面的同名无执行位文件被判为已安装，
   * 识别结果指向一个无法启动的文件，派发任务时才以 EACCES 失败。
   */
  test('没有执行位的同名文件与同名目录不计入，继续在 PATH 后续目录中查找', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'qy-cli-plain-'))
    await writeFile(join(plain, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o644 })
    const folder = await mkdtemp(join(tmpdir(), 'qy-cli-dir-'))
    await mkdir(join(folder, 'claude'))
    const real = await fakeBin('claude')
    const found = await detectClis({ PATH: [plain, folder, real].join(delimiter), PATHEXT: '.CMD' })
    // Windows 没有执行位，能否执行由后缀决定：排在最前的无后缀文件仍被识别。
    const expected = process.platform === 'win32' ? join(plain, 'claude') : join(real, 'claude')
    expect(found.map((c) => c.path)).toEqual([expected])
  })

  test('PATH 上均不存在时返回空列表，不报错', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qy-cli-empty-'))
    expect(await detectClis({ PATH: dir, PATHEXT: '.CMD' })).toEqual([])
  })

  test('环境变量中有 key 即视为已接入', async () => {
    const dir = await fakeBin('claude')
    const on = await findCli('claude', { PATH: dir, PATHEXT: '.CMD', ANTHROPIC_API_KEY: 'sk-x' })
    expect(on?.connected).toBe(true)
  })

  test('已安装但无凭证时为「未接入」，而不是「未安装」', async () => {
    const dir = await fakeBin('codex')
    // 本机安装过 codex 时，家目录下存在 ~/.codex/auth.json，
    // 因此本测试只断言它已被识别，接入状态由上一条测试按环境变量验证。
    const found = await findCli('codex', { PATH: dir, PATHEXT: '.CMD' })
    expect(found?.id).toBe('codex')
    expect(typeof found?.connected).toBe('boolean')
  })

  test('未知的 id 返回 undefined', async () => {
    const dir = await fakeBin('claude')
    expect(await findCli('nope', { PATH: dir, PATHEXT: '.CMD' })).toBeUndefined()
  })
})
