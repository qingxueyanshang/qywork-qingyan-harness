import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { installArgv, resolveWinget } from './host.ts'

describe('winget 执行位置', () => {
  const localAppData = 'C:\\Users\\Test User\\AppData\\Local'
  const alias = win32.join(localAppData, 'Microsoft', 'WindowsApps', 'winget.exe')

  test('PATH 缺失 WindowsApps 时使用可执行的应用别名', () => {
    expect(resolveWinget({ platform: 'win32', localAppData, probe: (exe) => exe === alias })).toBe(
      alias,
    )
  })

  test('PATH 中可用的位置优先，别名不能运行时不报告可安装', () => {
    expect(resolveWinget({ platform: 'win32', localAppData, probe: () => true })).toBe('winget')
    expect(resolveWinget({ platform: 'win32', localAppData, probe: () => false })).toBeNull()
    expect(
      resolveWinget({ platform: 'win32', localAppData: undefined, probe: () => false }),
    ).toBeNull()
    expect(resolveWinget({ platform: 'linux', localAppData, probe: () => true })).toBeNull()
  })

  test('缺失 PATH 的独立进程仍能探测真实别名，安装路由使用同一位置', async () => {
    if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) return
    const actualAlias = join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'winget.exe')
    const available =
      Bun.spawnSync(['cmd.exe', '/d', '/c', actualAlias, '--version'], {
        stdout: 'ignore',
        stderr: 'ignore',
      }).exitCode === 0
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'),
    )
    env.PATH = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
    const script = `
      import { resolveWinget, handleHostApi } from ${JSON.stringify(import.meta.resolve('./host.ts'))};
      const resolved = resolveWinget();
      let launched = null;
      Bun.spawn = (args) => { launched = args; return { unref() {} }; };
      const url = new URL('http://localhost/api/host/install');
      const response = await handleHostApi(url, new Request(url, {
        method: 'POST', body: JSON.stringify({ id: 'git' }),
      }), {});
      console.log(JSON.stringify({ resolved, launched, status: response.status, body: await response.json() }));
    `
    const result = Bun.spawnSync([process.execPath, '-e', script], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(result.exitCode).toBe(0)
    const out = JSON.parse(result.stdout.toString())
    expect(out.resolved).toBe(available ? actualAlias : null)
    expect(out.status).toBe(available ? 200 : 409)
    if (available) {
      expect(out.body.started).toBe(true)
      expect(out.launched).toEqual(installArgv(actualAlias, 'Git.Git'))
      expect(out.launched).toContain(actualAlias)
    } else {
      expect(out.launched).toBeNull()
    }
  })

  test('安装命令保留含空格的执行位置和包参数', async () => {
    if (process.platform !== 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'qywork-winget '))
    const stub = join(root, 'winget.cmd')
    await writeFile(stub, '@echo off\r\necho %*\r\nexit /b 0\r\n')
    const argv = installArgv(stub, 'Git.Git')
    // 执行安装窗口内的命令；测试替身只返回参数，不启动窗口或安装软件。
    const inner = argv.slice(argv.indexOf('cmd'))
    inner[inner.indexOf('/k')] = '/c'
    const result = Bun.spawnSync(inner, { stdout: 'pipe', stderr: 'pipe' })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString().trim()).toBe('install --id Git.Git -e --source winget')
  })
})
