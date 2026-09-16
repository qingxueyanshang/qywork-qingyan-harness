/** 覆盖 git/source/apply/handoff：真实 Git 下载与快进、目录保护、管理接口和退出前后交接。 */
import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { UpdateSnapshot } from '@qywork/core'
import {
  applySource,
  fetchRelease,
  git,
  newerVersion,
  preflight,
  SOURCE_URL,
  stableVersion,
} from './git.ts'
import { startSourceUpdater } from './source.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'updater-'))
  dirs.push(dir)
  const remote = join(dir, 'release')
  const root = join(dir, 'checkout')
  await mkdir(remote)
  await git(remote, ['init', '-b', 'master'])
  await git(remote, ['config', 'user.email', 'update@example.test'])
  await git(remote, ['config', 'user.name', 'Update Test'])
  await writeFile(join(remote, 'VERSION'), '1.0.0\n')
  await writeFile(join(remote, '.gitignore'), '.tmp/\nnode_modules/\n')
  await writeFile(join(remote, 'package.json'), '{"name":"update-fixture","private":true}')
  await mkdir(join(remote, 'scripts'))
  await writeFile(
    join(remote, 'scripts', 'dev.ts'),
    "await Bun.write('.tmp/restarted.json', JSON.stringify(process.argv.slice(2)))\n",
  )
  const install = Bun.spawn([process.execPath, 'install'], {
    cwd: remote,
    stdout: 'ignore',
    stderr: 'ignore',
  })
  expect(await install.exited).toBe(0)
  await git(remote, ['add', '.'])
  await git(remote, ['commit', '-m', 'base'])
  await git(dir, ['clone', remote, root])
  await git(root, ['config', 'user.email', 'update@example.test'])
  await git(root, ['config', 'user.name', 'Update Test'])
  // 只改当前测试仓库的 URL 重写，下载仍走生产 fetchRelease。
  await git(root, ['config', `url.${pathToFileURL(remote).href}.insteadOf`, SOURCE_URL])
  const head = await git(root, ['rev-parse', 'HEAD'])
  await writeFile(join(remote, 'VERSION'), '1.1.0\n')
  await git(remote, ['add', '.'])
  await git(remote, ['commit', '-m', 'release'])
  await git(remote, ['tag', 'v1.1.0'])
  const target = await git(remote, ['rev-parse', 'HEAD'])
  return { dir, remote, root, head, target }
}

test('只接受正式版本并按数值比较版本', () => {
  expect(newerVersion('1.10.0', '1.9.0')).toBe(true)
  expect(newerVersion('1.0.0', '1.1.0')).toBe(false)
  expect(newerVersion('1.0.0', '1.0.0')).toBe(false)
  for (const value of ['v1.2.0-beta', '1.2', '../master', '01.2.3'])
    expect(() => stableVersion(value)).toThrow()
})

test('下载只取对象，应用才快进并安装锁定依赖', async () => {
  const { root, head, target } = await fixture()
  expect(await fetchRelease(root, '1.1.0')).toBe(target)
  expect(await git(root, ['rev-parse', 'HEAD'])).toBe(head)
  expect((await readFile(join(root, 'VERSION'), 'utf8')).trim()).toBe('1.0.0')
  await applySource(root, target, head)
  expect(await git(root, ['rev-parse', 'HEAD'])).toBe(target)
  expect((await readFile(join(root, 'VERSION'), 'utf8')).trim()).toBe('1.1.0')
  expect(await git(root, ['status', '--porcelain'])).toBe('')
}, 20_000)

test('未提交文件、其它分支、领先或分叉都保留原源码', async () => {
  const { root, target, head } = await fixture()
  await fetchRelease(root, '1.1.0')
  await writeFile(join(root, 'local.txt'), 'keep me')
  await expect(applySource(root, target, head)).rejects.toThrow('未提交改动')
  expect(await readFile(join(root, 'local.txt'), 'utf8')).toBe('keep me')
  await git(root, ['add', 'local.txt'])
  await git(root, ['commit', '-m', 'local'])
  await expect(preflight(root, target)).rejects.toThrow('领先或已分叉')
  await git(root, ['checkout', '-b', 'feature'])
  await expect(preflight(root, target)).rejects.toThrow('master')
  expect(await readFile(join(root, 'local.txt'), 'utf8')).toBe('keep me')
}, 20_000)

test('发布标签版本不匹配、交接后 HEAD 变化均拒绝应用', async () => {
  const { remote, root, target } = await fixture()
  await git(remote, ['tag', 'v9.0.0'])
  await expect(fetchRelease(root, '9.0.0')).rejects.toThrow('不一致')
  await fetchRelease(root, '1.1.0')
  await expect(applySource(root, target, '0'.repeat(40))).rejects.toThrow('发生变化')
  const signal = AbortSignal.abort()
  await expect(git(root, ['status'], signal)).rejects.toThrow()
}, 20_000)

for (const mode of ['web', 'desktop'] as const) {
  test(`一次性更新程序等待父进程退出后更新并重新启动 ${mode}`, async () => {
    const { dir, root, head, target } = await fixture()
    await fetchRelease(root, '1.1.0')
    const parent = join(dir, 'parent.ts')
    await writeFile(
      parent,
      `
      import { handoffSourceUpdate } from ${JSON.stringify(join(import.meta.dir, 'handoff.ts'))}
      import { git } from ${JSON.stringify(join(import.meta.dir, 'git.ts'))}
      const request = ${JSON.stringify({ root, head, target, mode })}
      await handoffSourceUpdate({ ...request, parentPid: process.pid }, {})
      await Bun.sleep(300)
      if (await git(request.root, ['rev-parse', 'HEAD']) !== request.head) throw new Error('退出前源码已改变')
      process.exit(0)
    `,
    )
    const proc = Bun.spawn([process.execPath, parent], { stdout: 'pipe', stderr: 'pipe' })
    const error = await new Response(proc.stderr).text()
    expect({ code: await proc.exited, error }).toEqual({ code: 0, error: '' })
    const restarted = join(root, '.tmp', 'restarted.json')
    const deadline = Date.now() + 10_000
    while (!(await Bun.file(restarted).exists()) && Date.now() < deadline) await Bun.sleep(50)
    expect(await Bun.file(restarted).json()).toEqual(mode === 'web' ? ['--web', '--no-open'] : [])
    expect(await git(root, ['rev-parse', 'HEAD'])).toBe(target)
    expect((await Bun.file(join(root, '.tmp/update/result.json')).json()).failure).toBe(null)
  }, 20_000)
}

test.skipIf(process.platform !== 'win32')(
  '管理入口鉴权、检查下载、忙时等待取消、失败重试和退出交接',
  async () => {
    const { dir, root, target, head } = await fixture()
    const previousHome = process.env.QYWORK_HOME
    process.env.QYWORK_HOME = dir
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ updates: { autoCheck: false, autoDownload: false } }),
    )
    const realFetch = globalThis.fetch
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if (String(input).startsWith('https://api.github.com/'))
          return Response.json({ tag_name: 'v1.1.0', body: 'release notes' })
        return realFetch(input, init)
      },
      { preconnect: realFetch.preconnect },
    ) as typeof fetch
    let busy = true
    let claimed = false
    let failApply = true
    let applied = false
    const sidecar = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        expect(req.headers.get('x-qywork-update-key')).toBe('owner-key')
        const body = (await req.json()) as { action: string }
        claimed = body.action === 'claim' && !busy
        return Response.json({ claimed, busy: busy ? 1 : 0 })
      },
    })
    const updater = await startSourceUpdater({
      root,
      mode: 'web',
      sidecarPort: sidecar.port!,
      hostKey: 'owner-key',
      async apply(commit, previous) {
        expect(commit).toBe(target)
        expect(previous).toBe(head)
        if (failApply) throw new Error('交接失败')
        applied = true
      },
    })
    const request = (action: string) =>
      realFetch(`${updater.endpoint.base}/${action}`, {
        method: action === 'status' ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${updater.endpoint.token}` },
      })
    const stage = async (wanted: string) => {
      const deadline = Date.now() + 5000
      let value: UpdateSnapshot
      do {
        value = (await (await request('status')).json()) as UpdateSnapshot
        if (value.stage === wanted) return value
        await Bun.sleep(20)
      } while (Date.now() < deadline)
      throw new Error(`expected ${wanted}, got ${JSON.stringify(value)}`)
    }
    try {
      expect((await realFetch(`${updater.endpoint.base}/status`)).status).toBe(401)
      expect(
        (
          await realFetch(`${updater.endpoint.base}/status`, {
            headers: { Authorization: `Bearer ${'é'.repeat(48)}` },
          })
        ).status,
      ).toBe(401)
      expect(
        (
          await realFetch(`${updater.endpoint.base}/status`, {
            headers: { Origin: 'https://other.example' },
          })
        ).status,
      ).toBe(403)
      expect((await stage('idle')).mode).toBe('source-web')
      await request('check')
      expect((await stage('available')).version).toBe('1.1.0')
      await request('download')
      await stage('ready')
      expect(await git(root, ['rev-parse', 'HEAD'])).toBe(head)
      await request('install')
      await stage('waiting')
      await request('cancel')
      await stage('ready')
      expect(applied).toBe(false)
      expect(claimed).toBe(false)
      busy = false
      await request('install')
      expect((await stage('error')).error).toBe('交接失败')
      expect(claimed).toBe(false)
      failApply = false
      await request('install')
      await stage('installing')
      expect(applied).toBe(true)
      expect(claimed).toBe(true)
    } finally {
      updater.close()
      sidecar.stop(true)
      globalThis.fetch = realFetch
      if (previousHome === undefined) delete process.env.QYWORK_HOME
      else process.env.QYWORK_HOME = previousHome
    }
  },
  30_000,
)
