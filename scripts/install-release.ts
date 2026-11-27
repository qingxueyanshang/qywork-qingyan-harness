#!/usr/bin/env bun
/**
 * 把已公开的版本安装到本机：从官网下载 `VERSION` 对应的 Windows 安装包，按 SHA256SUMS 核对，
 * 备份数据库后静默安装到已安装 qywork 的位置。正式发布公开、官网同步之后运行（服务器每 10 分钟同步一次）：
 *
 *   bun run install:release
 *
 * 开发版与安装版共用数据目录：开发版执行新的数据库迁移后，旧的安装版因数据库的结构版本更高而拒绝启动。
 * 每次发版后安装同一版本，安装版即可再次打开；两次发版之间新增的迁移在下一次发版之前仍使安装版无法启动。
 *
 * 只支持 Windows。安装版正在运行时拒绝执行：安装程序会结束它，进行中的任务随之中断。
 */

import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const DOWNLOAD = 'https://qywork.io/download'
const UNINSTALL_KEYS = [
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\qywork',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\qywork',
]
/** 安装前的数据库备份只保留最近一份：数据库有数百 MB，每次发版各留一份会持续占用磁盘。 */
const BACKUP_PREFIX = 'qywork-before-install-'

/** `reg query <键>` 的输出中某个值的内容；值两侧的引号去除。没有该值时返回 null。 */
export function regValue(output: string, name: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s+(\S+)\s+REG_\w+\s+(.*)$/.exec(line)
    if (m?.[1] === name) return (m[2] ?? '').trim().replace(/^"(.*)"$/, '$1')
  }
  return null
}

/** SHA256SUMS 中某个文件的校验和（`<十六进制> *<文件名>` 或 `<十六进制>  <文件名>`）。 */
export function checksumOf(sums: string, file: string): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim())
    if (m?.[2] === file) return (m[1] ?? '').toLowerCase()
  }
  return null
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

/** 本机的安装位置与已安装的版本，取自卸载项。 */
function installed(): { dir: string; version: string } | null {
  for (const key of UNINSTALL_KEYS) {
    const out = Bun.spawnSync(['reg', 'query', key])
    if (out.exitCode !== 0) continue
    const text = new TextDecoder().decode(out.stdout)
    const dir = regValue(text, 'InstallLocation')
    if (dir) return { dir, version: regValue(text, 'DisplayVersion') ?? '' }
  }
  return null
}

/** 安装位置中正在运行的进程编号。 */
function runningIn(dir: string): string[] {
  const out = Bun.spawnSync(
    [
      'powershell',
      '-NoProfile',
      '-Command',
      "Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($env:QY_INSTALL_DIR + '\\', 'OrdinalIgnoreCase') } | ForEach-Object { $_.Id }",
    ],
    { env: { ...process.env, QY_INSTALL_DIR: dir } },
  )
  return new TextDecoder().decode(out.stdout).split(/\s+/).filter(Boolean)
}

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url)
  if (!res.ok) fail(`下载失败：HTTP ${res.status} ${url}`)
  return new Uint8Array(await res.arrayBuffer())
}

/**
 * 以 `VACUUM INTO` 备份主数据库：得到的是一致的快照，开发版此时仍可写入；直接复制文件可能取得写入一半的页。
 * 内容库（`qywork_content.sqlite3`）不备份：数据库迁移不修改它，且体积为数 GB。
 */
async function backup(version: string): Promise<string | null> {
  const home = process.env.QYWORK_HOME ?? join(homedir(), '.qywork')
  const db = join(home, 'qywork.sqlite3')
  if (!existsSync(db)) return null
  const dir = join(home, 'backups')
  await mkdir(dir, { recursive: true })
  const target = join(dir, `${BACKUP_PREFIX}${version}-${Date.now()}.sqlite3`)
  const conn = new Database(db, { readonly: true })
  try {
    conn.run(`VACUUM INTO '${target.replaceAll("'", "''")}'`)
  } finally {
    conn.close()
  }
  for (const name of await readdir(dir)) {
    if (name.startsWith(BACKUP_PREFIX) && join(dir, name) !== target) await rm(join(dir, name))
  }
  return target
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') fail('只支持 Windows')
  const version = (await Bun.file(join(ROOT, 'VERSION')).text()).trim()
  const current = installed()
  if (!current) fail('本机没有安装 qywork，未找到安装位置')
  // NSIS 的 /D= 必须是最后一个参数且不加引号，进程启动时含空格的参数会被加上引号。
  if (/\s/.test(current.dir)) fail(`安装位置含空格，无法静默安装：${current.dir}`)
  const running = runningIn(current.dir)
  if (running.length)
    fail(`安装版正在运行（进程 ${running.join('、')}），先退出 ${current.dir} 中的 qywork`)

  const file = `qywork_${version}_x64-setup.exe`
  const sums = new TextDecoder().decode(
    await download(`${DOWNLOAD}/v${version}/SHA256SUMS-windows-x86_64.txt`),
  )
  const expected = checksumOf(sums, file)
  if (!expected) fail(`官网的校验文件中没有 ${file}`)
  const bytes = await download(`${DOWNLOAD}/v${version}/${file}`)
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== expected) fail(`${file} 的 SHA-256 不一致：期望 ${expected}，实际 ${actual}`)
  const installer = join(ROOT, '.tmp', 'installer', file)
  await mkdir(join(ROOT, '.tmp', 'installer'), { recursive: true })
  await writeFile(installer, bytes)
  process.stdout.write(`已下载并核对 ${installer}\n`)

  const saved = await backup(version)
  if (saved) process.stdout.write(`数据库已备份到 ${saved}\n`)

  process.stdout.write(`安装 ${version}（当前 ${current.version || '未知'}）到 ${current.dir}\n`)
  const proc = Bun.spawn([installer, '/S', `/D=${current.dir}`], {
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const code = await proc.exited
  if (code !== 0) fail(`安装程序退出码 ${code}`)
  const after = installed()
  if (after?.version !== version)
    fail(`安装后的版本是 ${after?.version ?? '未知'}，不是 ${version}`)
  process.stdout.write(`已安装 ${version}\n`)
}

if (import.meta.main) await main()
