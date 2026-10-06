import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import type { EnvDependency } from '@qywork/core'
import type { OfficeHost, OfficeStatus, QyConfig } from '@qywork/runtime'
import {
  handleHostApi,
  installArgv,
  pipInstallArgv,
  probeEnvironment,
  resolveWinget,
} from './host.ts'

describe('winget 执行位置', () => {
  const localAppData = 'C:\\Users\\Test User\\AppData\\Local'
  const alias = win32.join(localAppData, 'Microsoft', 'WindowsApps', 'winget.exe')

  test('PATH 缺失 WindowsApps 时使用可执行的应用别名', () => {
    expect(resolveWinget({ platform: 'win32', localAppData, probe: (exe) => exe === alias })).toBe(
      alias,
    )
  })

  test('PATH 中可用的位置优先，别名无法运行时不报告可安装', () => {
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

describe('Office 依赖三行', () => {
  const missingPython = { providers: {}, officePython: join(tmpdir(), 'qywork-no-python.exe') }
  const host = (missing: string[], videoDecoder = true): OfficeHost => {
    const status: OfficeStatus = {
      enabled: true,
      available: missing.length === 0,
      reason: '',
      python: process.execPath,
      version: '3.12.0',
      missing,
      videoDecoder,
      apps: null,
    }
    return { refresh: async () => status, status: () => status, port: () => undefined }
  }
  const row = (rows: EnvDependency[], id: string) => rows.find((r) => r.id === id)

  test('指定的解释器不存在：两行均报告缺失，文档库提示先安装 Python', () => {
    const rows = probeEnvironment({ config: missingPython as QyConfig })
    expect(row(rows, 'python')).toMatchObject({ path: null, hint: 'Office 文档工具不可用。' })
    expect(row(rows, 'office-libs')).toMatchObject({ path: null, hint: '需要先安装 Python。' })
    expect(row(rows, 'office-libs')?.canInstall).toBe(false)
  })

  test('文档库缺项取 Office 宿主的探测结果', () => {
    const config = { providers: {}, officePython: process.execPath } as QyConfig
    const missing = probeEnvironment({ config, office: host(['pypdfium2', 'openpyxl']) })
    expect(row(missing, 'office-libs')).toMatchObject({
      path: null,
      hint: '缺少 pypdfium2、openpyxl。',
    })
    const ok = probeEnvironment({ config, office: host([]) })
    expect(row(ok, 'office-libs')).toMatchObject({ path: process.execPath, hint: '' })
  })

  /** 视频解码库可选：缺失时文档库一行仍然完整，视频解码库一行报告缺失并给出影响。 */
  test('视频解码库单独一行，缺失时不影响文档库', () => {
    const config = { providers: {}, officePython: process.execPath } as QyConfig
    const rows = probeEnvironment({ config, office: host([], false) })
    expect(row(rows, 'office-libs')).toMatchObject({ path: process.execPath, hint: '' })
    expect(row(rows, 'video-decoder')).toMatchObject({
      path: null,
      hint: '不支持原生视频的模型无法读取视频。',
    })
    const ok = probeEnvironment({ config, office: host([], true) })
    expect(row(ok, 'video-decoder')).toMatchObject({ path: process.execPath, hint: '' })
    const noPython = probeEnvironment({ config: missingPython as QyConfig })
    expect(row(noPython, 'video-decoder')).toMatchObject({
      path: null,
      hint: '需要先安装 Python。',
    })
  })

  test('没有解释器时安装文档库返回 409，不启动进程', async () => {
    if (process.platform !== 'win32') return
    const url = new URL('http://localhost/api/host/install')
    const res = await handleHostApi(
      url,
      new Request(url.href, { method: 'POST', body: JSON.stringify({ id: 'office-libs' }) }),
      { config: missingPython } as never,
    )
    expect(res?.status).toBe(409)
  })

  test('虚拟环境中的解释器不带 --user，系统解释器带 --user', async () => {
    const venv = await mkdtemp(join(tmpdir(), 'qywork-venv-'))
    await mkdir(join(venv, 'Scripts'))
    await writeFile(join(venv, 'pyvenv.cfg'), 'include-system-site-packages = false\n')
    expect(pipInstallArgv(join(venv, 'Scripts', 'python.exe'))).not.toContain('--user')
    const plain = await mkdtemp(join(tmpdir(), 'qywork-python-'))
    expect(pipInstallArgv(join(plain, 'python.exe'))).toContain('--user')
  })

  test('pip 安装命令在含空格的解释器与清单目录下照常执行', async () => {
    if (process.platform !== 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'qywork-python '))
    const stub = join(root, 'python.cmd')
    await writeFile(stub, '@echo off\r\necho %*\r\nexit /b 0\r\n')
    const argv = pipInstallArgv(stub)
    const inner = argv.slice(argv.indexOf('cmd'))
    inner[inner.indexOf('/k')] = '/c'
    const result = Bun.spawnSync(inner, { cwd: root, stdout: 'pipe', stderr: 'pipe' })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString().trim()).toBe('-m pip install --user -r requirements.txt')
  })
})
