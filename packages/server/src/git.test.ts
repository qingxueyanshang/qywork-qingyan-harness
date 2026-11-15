/**
 * 分支名数据源的边界。
 *
 * 覆盖 `git.ts` 的三项行为：**detached HEAD 返回 null 而不是名为 HEAD 的分支**，
 * **本机未安装 git 时的形状**，以及**git 子进程使用与 `run_command` 相同的凭证剥离**。
 * 其余行为由 git 自身保证，无需在此重复验证。
 */

import { describe, expect, test } from 'bun:test'
import { chmodSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { QyConfig } from '@qywork/runtime'
import { setCommandRunner, startCommandRunner } from '@qywork/tools'
import { branches, currentBranch, gitDir, switchTo } from './git.ts'

const CONFIG: QyConfig = { providers: {} }

async function repoWithCommit(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qy-git-'))
  const run = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: dir })
  run('init', '-q', '-b', 'main', '.')
  run('config', 'user.email', 't@t')
  run('config', 'user.name', 't')
  await Bun.write(join(dir, 'a.txt'), 'x')
  run('add', '.')
  run('commit', '-qm', 'x')
  return dir
}

describe('当前分支名', () => {
  test('位于分支上时返回分支名', async () => {
    expect(await currentBranch(await repoWithCommit(), CONFIG)).toBe('main')
  })

  /**
   * detached HEAD。**必须是 null，不能是字符串 `HEAD`**：
   * `rev-parse --abbrev-ref HEAD` 在该状态下返回的正是后者，界面会把它当作
   * 名为 HEAD 的分支显示在输入框上方。
   */
  test('detached HEAD 返回 null', async () => {
    const dir = await repoWithCommit()
    const sha = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: dir }).stdout.toString().trim()
    Bun.spawnSync(['git', 'checkout', '-q', sha], { cwd: dir })
    expect(await currentBranch(dir, CONFIG)).toBeNull()
  })

  test('不是仓库时返回 null', async () => {
    expect(await currentBranch(await mkdtemp(join(tmpdir(), 'qy-nogit-')), CONFIG)).toBeNull()
  })
})

describe('本机未安装 git', () => {
  /**
   * **不能抛出，只能报告「不是仓库」。**
   *
   * 原始失败形状由实测触发：将 PATH 精简到只剩 System32 后启动一次服务，
   * `Bun.spawn(['git', …])` 同步抛出 ENOENT，而广播处是
   * `void publishGitState(...)`：浮动 promise 无人处理，因此启动时输出大量调用栈，
   * 此后每次广播都重复一次。
   *
   * 「git 能否运行」本就属于 `git()` 的返回类型（它有 `ok: false` 这一分支），
   * 因此在该处处理，而不是给广播处加 `.catch`：后者是在下游掩盖症状。
   *
   * 将 PATH 指向一个空目录以构造该状态。不要改为空字符串：PATH 为空时 Bun 在 POSIX 上按
   * 默认路径查找，仍能找到 git。仓库位于分支上，返回 null 只能是因为未找到 git。
   */
  test('git 不在 PATH 上时返回 null，而不是抛出', async () => {
    const dir = await repoWithCommit()
    const empty = await mkdtemp(join(tmpdir(), 'qy-nopath-'))
    const prev = process.env.PATH
    process.env.PATH = empty
    try {
      expect(await currentBranch(dir, CONFIG)).toBeNull()
    } finally {
      process.env.PATH = prev
    }
  })
})

/**
 * `git switch` 执行 `.git/hooks/post-checkout`，`.git/` 可由模型写入。钩子取得的环境与 `run_command` 相同：
 * 名称形似凭证的变量与值等于已配置 key 的变量都不出现，其余变量照常传入。
 */
test('切换分支时钩子取得剥离凭证后的环境', async () => {
  const dir = await repoWithCommit()
  Bun.spawnSync(['git', 'branch', 'dev'], { cwd: dir })
  const dump = join(dir, '.git', 'hook-env.txt')
  const hook = join(dir, '.git', 'hooks', 'post-checkout')
  await writeFile(hook, `#!/bin/sh\nenv > "${dump.replaceAll('\\', '/')}"\n`)
  chmodSync(hook, 0o755)
  const key = 'sk-configured-key-0123456789'
  const config: QyConfig = {
    providers: { p: { kind: 'openai_chat_completions', apiKey: key, models: {} } },
  }
  process.env.QY_GIT_TEST_TOKEN = 'named-secret-value'
  process.env.QY_GIT_TEST_COPY = key
  process.env.QY_GIT_TEST_PLAIN = 'plain-value'
  try {
    expect((await switchTo(dir, 'dev', config)).ok).toBe(true)
    const seen = await readFile(dump, 'utf8')
    expect(seen).toContain('plain-value')
    expect(seen).not.toContain('named-secret-value')
    expect(seen).not.toContain(key)
  } finally {
    delete process.env.QY_GIT_TEST_TOKEN
    delete process.env.QY_GIT_TEST_COPY
    delete process.env.QY_GIT_TEST_PLAIN
  }
})

test('经命令 runner 读取和切换分支，缺失 Git 时仍返回空状态', async () => {
  const dir = await repoWithCommit()
  const empty = await mkdtemp(join(tmpdir(), 'qy-runner-nopath-'))
  Bun.spawnSync(['git', 'branch', 'dev'], { cwd: dir })
  const runner = startCommandRunner([
    process.execPath,
    '-e',
    'import { runCommandRunner } from "@qywork/tools"; runCommandRunner()',
  ])
  const prev = process.env.PATH
  setCommandRunner(runner)
  try {
    expect(await currentBranch(dir, CONFIG)).toBe('main')
    expect(await gitDir(dir, CONFIG)).toBeTruthy()
    expect((await branches(dir, CONFIG)).map((b) => b.name)).toEqual(['dev', 'main'])
    expect((await switchTo(dir, 'dev', CONFIG)).ok).toBe(true)
    expect(await currentBranch(dir, CONFIG)).toBe('dev')
    process.env.PATH = empty
    expect(await currentBranch(dir, CONFIG)).toBeNull()
  } finally {
    process.env.PATH = prev
    setCommandRunner(null)
    runner.stop()
  }
})

/**
 * 切换被拒绝时的提示。**只测形状不测措辞**：断言中出现的是文件名与「未提交」等关键字，
 * 换一种表述不应使测试失败。
 */
describe('无法切换时给出可读的提示', () => {
  async function dirtyBlocked(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'qy-git-sw-'))
    const run = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: dir })
    run('init', '-q', '-b', 'main', '.')
    run('config', 'user.email', 't@t')
    run('config', 'user.name', 't')
    await Bun.write(join(dir, 'a.txt'), 'main')
    run('add', '.')
    run('commit', '-qm', 'main')
    run('switch', '-qc', 'dev')
    await Bun.write(join(dir, 'a.txt'), 'dev')
    run('commit', '-qam', 'dev')
    run('switch', '-q', 'main')
    // 该文件既未提交，又恰好是两条分支之间存在差异的文件，git 必然拒绝切换。
    await Bun.write(join(dir, 'a.txt'), '我自己改的')
    const r = await switchTo(dir, 'dev', CONFIG)
    expect(r.ok).toBe(false)
    return r.message
  }

  test('指出具体文件，且不输出英文', async () => {
    const msg = await dirtyBlocked()
    expect(msg).toContain('a.txt')
    expect(msg).toContain('未提交')
    // 必须压缩为一行：原始输出是四行带缩进的英文。
    expect(msg).not.toContain('\n')
    expect(msg).not.toContain('overwritten')
  })

  test('不存在该分支时不运行 git', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qy-git-none-'))
    Bun.spawnSync(['git', 'init', '-q', '-b', 'main', '.'], { cwd: dir })
    const r = await switchTo(dir, '--output=pwned', CONFIG)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('本地分支不存在')
  })
})
