import { realpathSync } from 'node:fs'
import { join } from 'node:path'

export const RELEASE_REPO = 'qingxueyanshang/qywork-qingyan-harness'
export const SOURCE_URL = `https://github.com/${RELEASE_REPO}.git`

export function stableVersion(value: string): string {
  const version = value.replace(/^v/, '')
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('发布版本号无效')
  return version
}

export function newerVersion(candidate: string, current: string): boolean {
  const a = stableVersion(candidate).split('.').map(Number)
  const b = stableVersion(current).split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i]! > b[i]!
  }
  return false
}

export async function git(root: string, args: string[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const proc = Bun.spawn(['git', '-C', root, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  const stop = () => proc.kill()
  signal?.addEventListener('abort', stop, { once: true })
  const timeout = setTimeout(stop, 120_000)
  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    signal?.throwIfAborted()
    if (code !== 0) throw new Error(err.trim() || `Git 执行失败（${code}）`)
    return out.trim()
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', stop)
  }
}

export async function sourceRoot(root: string): Promise<void> {
  const top = await git(root, ['rev-parse', '--show-toplevel'])
  const key = (path: string) =>
    process.platform === 'win32' ? realpathSync(path).toLowerCase() : realpathSync(path)
  if (key(top) !== key(root)) throw new Error('启动目录不是 qywork 源码仓库根目录')
}

export async function fetchRelease(
  root: string,
  version: string,
  signal?: AbortSignal,
): Promise<string> {
  stableVersion(version)
  await sourceRoot(root)
  const ref = `refs/qywork/updates/v${version}`
  await git(
    root,
    ['fetch', '--no-tags', '--no-recurse-submodules', SOURCE_URL, `refs/tags/v${version}:${ref}`],
    signal,
  )
  const commit = await git(root, ['rev-parse', '--verify', `${ref}^{commit}`], signal)
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('发布提交无效')
  const actual = await git(root, ['show', `${commit}:VERSION`], signal)
  if (actual !== version) throw new Error('发布标签与源码版本不一致')
  return commit
}

export async function preflight(
  root: string,
  target: string,
): Promise<{ head: string; branch: string }> {
  await sourceRoot(root)
  if (!/^[a-f0-9]{40,64}$/.test(target)) throw new Error('更新提交无效')
  if (await git(root, ['status', '--porcelain', '--untracked-files=all']))
    throw new Error('源码有未提交改动，请处理后重试')
  const branch = await git(root, ['symbolic-ref', '--short', 'HEAD']).catch(() => '')
  if (branch !== 'master') throw new Error('当前不是 master 分支，请手动更新')
  const head = await git(root, ['rev-parse', 'HEAD'])
  if (head === target) throw new Error('源码已是目标版本')
  try {
    await git(root, ['merge-base', '--is-ancestor', head, target])
  } catch {
    throw new Error('本地源码领先或已分叉，请手动更新')
  }
  return { head, branch }
}

export async function applySource(
  root: string,
  target: string,
  expectedHead: string,
): Promise<void> {
  const { head } = await preflight(root, target)
  if (head !== expectedHead) throw new Error('源码在更新前已发生变化，请重新检查')
  await git(root, ['merge', '--ff-only', '--no-edit', target])
  const install = Bun.spawn([process.execPath, 'install', '--frozen-lockfile'], {
    cwd: root,
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const timeout = setTimeout(() => install.kill(), 10 * 60 * 1000)
  try {
    if ((await install.exited) !== 0)
      throw new Error('依赖安装失败；源码已更新，修复依赖后重新启动')
  } finally {
    clearTimeout(timeout)
  }
  const version = (await Bun.file(join(root, 'VERSION')).text()).trim()
  if (version !== (await git(root, ['show', `${target}:VERSION`])))
    throw new Error('更新后的版本校验失败')
}
