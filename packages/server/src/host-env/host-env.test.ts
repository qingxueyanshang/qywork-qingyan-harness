/**
 * 覆盖 `host-env/` 下的 `unzip.ts`（权限位、符号链接、路径越界）、`chromium.ts`（下载校验、解压、安装记录与重启请求）
 * 与 `managers.ts`（终端命令的转义）。
 *
 * 压缩包在测试中按 zip 格式逐字节写出：需要 Unix 的文件模式与符号链接，常用的压缩库不写入这两项。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configDir } from '@qywork/runtime'
import {
  type Build,
  chromiumBuild,
  chromiumInstallState,
  installChromium,
  installedChromium,
} from './chromium.ts'
import { shellQuote, terminalArgv } from './managers.ts'
import { unzip } from './unzip.ts'

interface ZipItem {
  name: string
  data?: string
  /** Unix 文件模式（含类型位）。 */
  mode: number
}

/** 写出只含存储条目、制作系统为 Unix 的 zip。 */
function zipBytes(items: ZipItem[]): Uint8Array {
  const enc = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const item of items) {
    const name = enc.encode(item.name)
    const data = enc.encode(item.data ?? '')
    const local = new Uint8Array(30 + name.length + data.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 10, true)
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, data.length, true)
    lv.setUint16(26, name.length, true)
    local.set(name, 30)
    local.set(data, 30 + name.length)
    const central = new Uint8Array(46 + name.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, (3 << 8) | 20, true)
    cv.setUint16(6, 10, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(38, (item.mode << 16) >>> 0, true)
    cv.setUint32(42, offset, true)
    central.set(name, 46)
    locals.push(local)
    centrals.push(central)
    offset += local.length
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, items.length, true)
  ev.setUint16(10, items.length, true)
  ev.setUint32(12, cdSize, true)
  ev.setUint32(16, offset, true)
  const out = new Uint8Array(offset + cdSize + 22)
  let at = 0
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at)
    at += part.length
  }
  return out
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qywork-host-env-'))
  dirs.push(dir)
  return dir
}

describe('unzip', () => {
  test('保留可执行权限，目录与文件按原路径写出', async () => {
    const dir = scratch()
    const zip = join(dir, 'a.zip')
    await Bun.write(
      zip,
      zipBytes([
        { name: 'pkg/', mode: 0o040755 },
        { name: 'pkg/chrome', data: '#!/bin/sh\n', mode: 0o100755 },
        { name: 'pkg/data.txt', data: 'hello', mode: 0o100644 },
      ]),
    )
    await unzip(zip, join(dir, 'out'))
    expect(readFileSync(join(dir, 'out', 'pkg', 'data.txt'), 'utf8')).toBe('hello')
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, 'out', 'pkg', 'chrome')).mode & 0o777).toBe(0o755)
    }
  })

  test('路径含 .. 或指向目标目录之外的链接时整体失败', async () => {
    const dir = scratch()
    const outside = join(dir, 'escape.zip')
    await Bun.write(outside, zipBytes([{ name: '../x.txt', data: 'x', mode: 0o100644 }]))
    await expect(unzip(outside, join(dir, 'out1'))).rejects.toThrow('路径无效')
    const link = join(dir, 'link.zip')
    await Bun.write(link, zipBytes([{ name: 'a', data: '../../etc', mode: 0o120777 }]))
    await expect(unzip(link, join(dir, 'out2'))).rejects.toThrow('目标目录之外')
  })
})

describe('专用 Chromium', () => {
  test('只在有构建的平台上提供', () => {
    expect(chromiumBuild('linux', 'x64')?.exe).toBe('chrome-linux64/chrome')
    expect(chromiumBuild('darwin', 'arm64')?.exe).toContain('Google Chrome for Testing.app')
    expect(chromiumBuild('win32', 'x64')).toBeNull()
  })

  /**
   * 原始失败形状：Mac 与 Linux 上没有 Chrome 时内置浏览器无法使用，运行环境也没有安装入口。
   * 下载核对 SHA-256 后解压，写入宿主读取的安装记录，再请求宿主重启；校验不一致时不写入记录。
   */
  test('校验一致时解压并写入安装记录，然后请求重启；不一致时报告失败', async () => {
    const zip = zipBytes([
      { name: 'chrome-test/', mode: 0o040755 },
      { name: 'chrome-test/chrome', data: '#!/bin/sh\n', mode: 0o100755 },
    ])
    const build: Build = {
      platform: 'test',
      size: zip.length,
      sha256: new Bun.CryptoHasher('sha256').update(zip).digest('hex'),
      exe: 'chrome-test/chrome',
    }
    const fetched: string[] = []
    const fake = (async (url: string) => {
      fetched.push(url)
      return new Response(zip)
    }) as unknown as typeof fetch

    let restarted = 0
    await installChromium(
      async () => {
        restarted += 1
      },
      fake,
      build,
    )
    expect(chromiumInstallState()).toBeNull()
    expect(restarted).toBe(1)
    expect(fetched[0]).toMatch(/\/test\/chrome-test\.zip$/)
    const exe = installedChromium()
    expect(exe?.endsWith(join('chrome-test', 'chrome'))).toBe(true)
    const manifest = JSON.parse(
      readFileSync(join(configDir(), 'browser', 'chromium', 'installed.json'), 'utf8'),
    ) as { version: string; exe: string }
    expect(manifest.exe).toBe(exe ?? '')
    // 只保留当前版本的目录与安装记录，下载的压缩包已删除。
    const left = new Bun.Glob('*').scanSync({
      cwd: join(configDir(), 'browser', 'chromium'),
      onlyFiles: false,
    })
    expect([...left].sort()).toEqual([manifest.version, 'installed.json'].sort())

    await installChromium(
      async () => {
        restarted += 1
      },
      fake,
      { ...build, sha256: '0'.repeat(64) },
    )
    expect(chromiumInstallState()).toEqual({ failed: '下载的文件校验不一致' })
    expect(restarted).toBe(1)
    expect(existsSync(exe ?? '')).toBe(true)
  })
})

describe('终端命令', () => {
  test('macOS 经 AppleScript 执行，命令按 shell 与 AppleScript 两层转义', () => {
    const argv = terminalArgv('t', ['sudo', "it's", 'a"b'], '/Users/a b', 'darwin') ?? []
    expect(argv.slice(0, 2)).toEqual(['osascript', '-e'])
    expect(argv[2]).toBe(
      `tell application "Terminal" to do script "cd '/Users/a b' && 'sudo' 'it'\\\\''s' 'a\\"b'; echo; printf '%s' '安装命令已结束，按回车键关闭窗口。'; read _"`,
    )
  })

  test('单引号转义', () => {
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`)
  })
})
