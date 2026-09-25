/** 覆盖 start.ps1 的 Bun 原生入口解析与启动失败时保留错误、等待一次按键的行为。 */
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const windows = process.platform === 'win32'
const system = process.env.SystemRoot ?? 'C:\\Windows'
const powershell = join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const script = join(import.meta.dir, 'start.ps1')
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
const encoded = (source: string) => Buffer.from(source, 'utf16le').toString('base64')
/**
 * 等 Windows PowerShell 5.1 起来并输出的上限。新建的 CI 虚拟机上它首次启动超过 5 秒
 * （2026-09-23 CI 上两条用例都停在 5 秒的上限），本机热启动约 0.1 秒。
 */
const POWERSHELL_START_MS = 30_000

function pathEnv(path: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key]
  env.PATH = `${path};${join(system, 'System32')}`
  return env
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + POWERSHELL_START_MS
  while (!check() && Date.now() < deadline) await Bun.sleep(20)
  expect(check()).toBe(true)
}

test.skipIf(!windows)(
  'PATH 只有 npm 的 bun.cmd 时，解析到真正的 bun.exe',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'start npm shim '))
    writeFileSync(join(dir, 'bun.cmd'), `@echo off\r\n"${process.execPath}" %*\r\n`)
    try {
      const proc = Bun.spawn(
        [
          powershell,
          '-NoProfile',
          '-EncodedCommand',
          encoded(`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(${quote(script)}, [ref]$tokens, [ref]$errors)
$function = $ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Resolve-Bun'}, $true)
Invoke-Expression $function.Extent.Text
Resolve-Bun
`),
        ],
        { env: pathEnv(dir), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      )
      const [code, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      expect(stderr).toBe('')
      expect(code).toBe(0)
      expect(stdout.trim().toLowerCase()).toBe(process.execPath.toLowerCase())
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
  POWERSHELL_START_MS,
)

test.skipIf(!windows)(
  '真正缺少 Bun 时保留错误，回车后以失败码退出',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'start missing bun '))
    const proc = Bun.spawn(
      [powershell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
      {
        env: pathEnv(dir),
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    let output = ''
    const stdout = (async () => {
      for await (const chunk of proc.stdout) output += new TextDecoder().decode(chunk)
    })()
    const stderr = new Response(proc.stderr).text()
    try {
      await until(() => output.includes('PATH'))
      expect(proc.exitCode).toBeNull()
      proc.stdin.write('\r\n')
      proc.stdin.end()
      expect(await proc.exited).toBe(1)
      await stdout
      expect(await stderr).toBe('')
    } finally {
      proc.kill()
      await proc.exited
      rmSync(dir, { recursive: true, force: true })
    }
  },
  POWERSHELL_START_MS + 10_000,
)
