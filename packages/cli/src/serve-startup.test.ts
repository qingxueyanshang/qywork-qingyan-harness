import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 在真实进程创建位置同步阻塞 Git，直到父测试主动放行；只延迟命令执行无法复现此问题。 */
const preloadSource = `
import { existsSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
const actual = Bun.spawn.bind(Bun)
let first = true
Bun.spawn = function(argv, options) {
  if (argv.includes('runner')) {
    argv = [argv[0], '--preload', import.meta.path, ...argv.slice(1)]
  }
  if (first && /^(git|git.exe)$/i.test(basename(argv[0]))) {
    first = false
    writeFileSync(process.env.QY_TEST_GIT_BLOCKED, String(process.pid))
    const deadline = Date.now() + 15000
    while (!existsSync(process.env.QY_TEST_GIT_RELEASE) && Date.now() < deadline) Bun.sleepSync(10)
  }
  return actual(argv, options)
}
`

async function until(predicate: () => boolean, message: string): Promise<void> {
  const deadline = performance.now() + 10_000
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(message)
    await Bun.sleep(10)
  }
}

test('Git 创建进程被阻塞时，serve 仍交付就绪回执并响应 HTTP', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qy-serve-startup-'))
  const home = join(dir, 'home')
  const workspace = join(dir, 'workspace')
  await mkdir(home)
  await mkdir(workspace)
  await writeFile(join(home, 'config.json'), '{}')
  const preload = join(dir, 'preload.ts')
  const blocked = join(dir, 'blocked')
  const release = join(dir, 'release')
  await writeFile(preload, preloadSource)
  const proc = Bun.spawn(
    [
      process.execPath,
      '--preload',
      preload,
      join(import.meta.dir, 'index.ts'),
      'serve',
      '--port',
      '0',
      '--host',
      '127.0.0.1',
      '--print-token',
      '--cwd',
      workspace,
      '--parent-pid',
      String(process.pid),
    ],
    {
      env: {
        ...process.env,
        QYWORK_HOME: home,
        QY_TEST_GIT_BLOCKED: blocked,
        QY_TEST_GIT_RELEASE: release,
      },
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    },
  )
  let output = ''
  const stdout = (async () => {
    for await (const chunk of proc.stdout) output += new TextDecoder().decode(chunk)
  })()
  const stderr = new Response(proc.stderr).text()
  try {
    await until(() => existsSync(blocked), '未进入 Git 创建阶段')
    await until(() => /QYWORK_PORT=\d+/.test(output), 'Git 创建进程阻塞了就绪回执')
    expect(output).toMatch(/QYWORK_TOKEN=\S+/)
    // 放行之前验证 HTTP：仅把 Git 延后一个事件循环仍会阻塞这里。
    const port = /QYWORK_PORT=(\d+)/.exec(output)?.[1]
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(2000),
    })
    expect(response.status).toBe(200)
    expect(Number(await readFile(blocked, 'utf8'))).not.toBe(proc.pid)
    expect(proc.exitCode).toBeNull()
    const log = await readFile(join(home, 'logs', 'qy.log'), 'utf8')
    expect(log).toContain('next=就绪')
    expect(log).toContain('durationMs=')
  } finally {
    await writeFile(release, '')
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
    } else {
      proc.kill()
    }
    await proc.exited
    await Promise.all([stdout, stderr])
  }
}, 30_000)
