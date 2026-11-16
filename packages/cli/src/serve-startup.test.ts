/**
 * 覆盖 `index.ts` 的 `qy serve` 启动：就绪回执不被 Git 创建进程阻塞；`--credentials-stdin` 交付的凭据与上次退出信息
 * 被采用（后者经 `server/process-exit.ts` 解析、写入启动回收的轮次），且不出现在 serve 启动的子进程的环境中；
 * 凭据行缺失或不合法时以非零退出码结束。
 */

import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NATIVE_DESKTOP_PATH, NATIVE_HOST_KEY_HEADER } from '@qywork/core'
import {
  createConversation,
  createRun,
  getRun,
  markRunRunning,
  Store,
  upsertWorkspace,
} from '@qywork/store'

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

/** runner 以默认选项启动、继承 serve 的环境块；在其中记录该环境。 */
const runnerEnvPreload = `
import { writeFileSync } from 'node:fs'
if (process.argv.includes('runner')) writeFileSync(process.env.QY_TEST_RUNNER_ENV, JSON.stringify(process.env))
const actual = Bun.spawn.bind(Bun)
Bun.spawn = function(argv, options) {
  if (argv.includes('runner')) argv = [argv[0], '--preload', import.meta.path, ...argv.slice(1)]
  return actual(argv, options)
}
`

function killTree(proc: { pid: number; kill(): void }): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    })
  } else {
    proc.kill()
  }
}

/**
 * 以外壳相同的方式启动：`--credentials-stdin`，写入一行凭据与上次退出信息后保持管道打开。
 * 原始失败形状是凭据与上次退出的 stderr 尾部经环境变量交付时，serve 启动的全部后代进程都能读到它们
 * （Bun 中删除 `process.env` 的键对不传 `env` 启动的 runner 无效）。
 */
test('经标准输入交付的凭据与上次退出信息被采用，且不出现在子进程与 git 钩子的环境中', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qy-serve-credentials-'))
  const home = join(dir, 'home')
  const workspace = join(dir, 'workspace')
  await mkdir(home)
  await mkdir(workspace)
  await writeFile(join(home, 'config.json'), '{}')
  const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: workspace })
  git('init', '-q', '-b', 'main', '.')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  await writeFile(join(workspace, 'a.txt'), 'x')
  git('add', '.')
  git('commit', '-qm', 'x')
  git('branch', 'dev')
  const hookEnv = join(dir, 'hook-env.txt')
  const hook = join(workspace, '.git', 'hooks', 'post-checkout')
  await writeFile(hook, `#!/bin/sh\nenv > "${hookEnv.replaceAll('\\', '/')}"\n`)
  chmodSync(hook, 0o755)
  const preload = join(dir, 'preload.ts')
  const runnerEnv = join(dir, 'runner-env.json')
  await writeFile(preload, runnerEnvPreload)

  const credentials = {
    token: `token-${crypto.randomUUID()}`,
    hostKey: `host-${crypto.randomUUID()}`,
    updateKey: `update-${crypto.randomUUID()}`,
  }
  // 账本中一轮无归属的 running：启动回收把它写为中断，并记入上次退出的信息。
  const ledger = new Store({ path: join(home, 'qywork.sqlite3') })
  const ws = upsertWorkspace(ledger, workspace, 'ws')
  const conv = createConversation(ledger, { workspaceId: ws.id, provider: 'p', model: 'm' })
  const stale = createRun(ledger, {
    conversationId: conv.id,
    workspaceId: ws.id,
    model: 'm',
    clientRequestId: crypto.randomUUID(),
    userMessageId: null,
    messageIdUpperBound: null,
    contextSnapshot: [],
  })
  markRunRunning(ledger, stale.id)
  ledger.db.query('UPDATE runs SET owner_pid = NULL WHERE id = ?').run(stale.id)
  ledger.close()
  const stderrTail = `panic-${crypto.randomUUID()}`
  const previousExit = { kind: 'terminated', observedAtMs: 1234, code: 3, signal: null, stderrTail }
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
      '--parent-pid',
      String(process.pid),
      '--credentials-stdin',
      '--cwd',
      workspace,
    ],
    {
      env: { ...process.env, QYWORK_HOME: home, QY_TEST_RUNNER_ENV: runnerEnv },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  proc.stdin.write(`${JSON.stringify({ ...credentials, previousExit })}\n`)
  proc.stdin.flush()
  let output = ''
  const stdout = (async () => {
    for await (const chunk of proc.stdout) output += new TextDecoder().decode(chunk)
  })()
  const stderr = new Response(proc.stderr).text()
  let stopped = false
  try {
    await until(() => /QYWORK_PORT=\d+/.test(output), '未输出就绪回执')
    // 恢复重启依赖这一点：外壳交付原令牌，serve 必须采用它而不是另行生成。
    expect(output).toContain(`QYWORK_TOKEN=${credentials.token}\n`)
    const base = `http://127.0.0.1:${/QYWORK_PORT=(\d+)/.exec(output)?.[1]}`
    const auth = { authorization: `Bearer ${credentials.token}` }
    const switched = await fetch(`${base}/api/git/switch`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ branch: 'dev' }),
    })
    expect(switched.status).toBe(200)
    // 宿主凭据与更新凭据同样被采用：凭据正确时两条路径越过鉴权。
    const host = await fetch(`${base}${NATIVE_DESKTOP_PATH}`, {
      headers: { [NATIVE_HOST_KEY_HEADER]: credentials.hostKey },
    })
    expect(host.status).toBe(400)
    const update = await fetch(`${base}/internal/app-update`, {
      method: 'POST',
      headers: { 'x-qywork-update-key': credentials.updateKey },
      body: JSON.stringify({ action: 'cancel' }),
    })
    expect(update.status).toBe(200)

    await until(() => existsSync(runnerEnv), 'runner 未记录环境')
    const seen = [await readFile(runnerEnv, 'utf8'), await readFile(hookEnv, 'utf8')]
    for (const text of seen) {
      for (const value of [...Object.values(credentials), stderrTail]) {
        expect(text).not.toContain(value)
      }
    }

    killTree(proc)
    await proc.exited
    stopped = true
    const after = new Store({ path: join(home, 'qywork.sqlite3') })
    try {
      expect(getRun(after, stale.id)?.interruption).toMatchObject({
        source: 'desktop_sidecar',
        exitKind: 'terminated',
        exitCode: 3,
        stderrTail,
      })
    } finally {
      after.close()
    }
  } finally {
    if (!stopped) killTree(proc)
    await proc.exited
    await Promise.all([stdout, stderr])
  }
}, 30_000)

/** 凭据行缺失或不合法时不启动服务，以非零退出码结束并说明原因。 */
test('凭据行缺失或不合法时以退出码 2 结束，不输出就绪回执', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qy-serve-credentials-bad-'))
  /** `line` 为 null 时不提供标准输入（立即结束）；否则写入该行后关闭。 */
  const run = async (line: string | null) => {
    const proc = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, 'index.ts'),
        'serve',
        '--port',
        '0',
        '--print-token',
        '--credentials-stdin',
      ],
      {
        env: { ...process.env, QYWORK_HOME: home },
        stdin: line === null ? 'ignore' : new TextEncoder().encode(`${line}\n`),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const exitCode = await Promise.race([proc.exited, Bun.sleep(15_000).then(() => null)])
    if (exitCode === null) {
      killTree(proc)
      await proc.exited
    }
    return {
      exitCode,
      stdout: await new Response(proc.stdout).text(),
      stderr: await new Response(proc.stderr).text(),
    }
  }

  for (const line of [null, 'not json', '[]', '{"token":""}', '{"tokn":"x"}']) {
    const got = await run(line)
    expect(got.exitCode).toBe(2)
    expect(got.stdout).not.toContain('QYWORK_PORT=')
    expect(got.stderr).toContain('凭据读取失败')
  }
}, 60_000)
