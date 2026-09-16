import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { UpdateAction, UpdatePreferences, UpdateSnapshot } from '@qywork/core'
import { configPath } from '@qywork/runtime'
import {
  fetchRelease,
  newerVersion,
  preflight,
  RELEASE_REPO,
  sourceRoot,
  stableVersion,
} from './git.ts'

const CHECK_INTERVAL = 6 * 60 * 60 * 1000
const ORIGINS = new Set(['http://127.0.0.1:5180', 'http://localhost:5180'])

export interface SourceUpdateOptions {
  root: string
  mode: 'desktop' | 'web'
  sidecarPort: number
  hostKey: string
  apply(target: string, head: string): Promise<void>
}

export async function startSourceUpdater(options: SourceUpdateOptions) {
  const key = randomBytes(24).toString('hex')
  const currentVersion = (await readFile(join(options.root, 'VERSION'), 'utf8')).trim()
  const supported =
    process.platform === 'win32' &&
    (await sourceRoot(options.root).then(
      () => true,
      () => false,
    ))
  const state: UpdateSnapshot = {
    mode: supported ? (options.mode === 'web' ? 'source-web' : 'source-desktop') : 'manual',
    currentVersion,
    stage: 'idle',
    version: null,
    notes: '',
    progress: null,
    checkedAt: null,
    error: null,
    retry: 'check',
  }
  const receipt = join(options.root, '.tmp', 'update', 'result.json')
  try {
    const result = JSON.parse(await readFile(receipt, 'utf8')) as { failure: string | null }
    if (result.failure) {
      state.stage = 'error'
      state.error = result.failure
      state.checkedAt = Date.now()
    }
    await rm(receipt)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      process.stderr.write(`[update] 无法读取更新结果：${String(error)}\n`)
  }
  let target: string | null = null
  let job: AbortController | null = null
  let closed = false
  let downloadPaused = false
  const claim = async (action: 'claim' | 'cancel') => {
    const response = await fetch(`http://127.0.0.1:${options.sidecarPort}/internal/app-update`, {
      method: 'POST',
      headers: { 'x-qywork-update-key': options.hostKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) throw new Error('无法确认任务是否空闲')
    return (await response.json()) as { claimed: boolean; busy: number }
  }

  async function run(action: Exclude<UpdateAction, 'status' | 'cancel'>): Promise<void> {
    if (!supported || job || closed) return
    if ((action === 'download' || action === 'install') && !state.version)
      throw new Error('请先检查更新')
    if (action === 'install' && !target) throw new Error('请先下载更新')
    const control = new AbortController()
    job = control
    if (action === 'check' || action === 'download') downloadPaused = false
    state.error = null
    state.retry = action
    state.stage =
      action === 'check' ? 'checking' : action === 'download' ? 'downloading' : 'waiting'
    let claimed = false
    try {
      if (action === 'check') {
        target = null
        state.version = null
        state.notes = ''
        state.checkedAt = Date.now()
        const response = await fetch(
          `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`,
          {
            headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'qywork-updater' },
            signal: AbortSignal.any([control.signal, AbortSignal.timeout(20_000)]),
          },
        )
        if (response.status === 404) {
          state.stage = 'latest'
          return
        }
        if (!response.ok) throw new Error(`检查更新失败（HTTP ${response.status}）`)
        const release = (await response.json()) as {
          tag_name?: string
          draft?: boolean
          prerelease?: boolean
          body?: string
        }
        if (!release.tag_name || release.draft || release.prerelease)
          throw new Error('发布信息无效')
        const version = stableVersion(release.tag_name)
        if (!newerVersion(version, currentVersion)) {
          state.stage = 'latest'
          return
        }
        state.version = version
        state.notes = release.body ?? ''
        state.stage = 'available'
      } else if (action === 'download') {
        target = await fetchRelease(options.root, state.version!, control.signal)
        state.stage = 'ready'
      } else {
        const checked = await preflight(options.root, target!)
        while (!control.signal.aborted) {
          const result = await claim('claim')
          if (result.claimed) {
            claimed = true
            break
          }
          await Bun.sleep(1000)
        }
        control.signal.throwIfAborted()
        const rechecked = await preflight(options.root, target!)
        if (checked.head !== rechecked.head) throw new Error('源码已变化，请重新检查')
        control.signal.throwIfAborted()
        state.stage = 'installing'
        await options.apply(target!, checked.head)
      }
    } catch (error) {
      if (claimed) await claim('cancel').catch(() => {})
      if (control.signal.aborted)
        state.stage = target ? 'ready' : state.version ? 'available' : 'idle'
      else {
        state.stage = 'error'
        state.error = error instanceof Error ? error.message : String(error)
      }
    } finally {
      job = null
    }
  }

  async function autoCheck() {
    if (job || closed || !supported) return
    try {
      const raw = await readFile(configPath(), 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '{}'
        throw error
      })
      const config = JSON.parse(raw) as { updates?: UpdatePreferences }
      const prefs = config.updates ?? { autoCheck: true, autoDownload: true }
      if (typeof prefs.autoCheck !== 'boolean' || typeof prefs.autoDownload !== 'boolean') return
      if (!prefs.autoDownload) downloadPaused = false
      if (
        prefs.autoCheck &&
        !['ready', 'available'].includes(state.stage) &&
        Date.now() - (state.checkedAt ?? 0) >= CHECK_INTERVAL
      )
        await run('check')
      if (prefs.autoDownload && !downloadPaused && state.stage === 'available')
        await run('download')
    } catch {
      /* 配置读取失败时不启动自动操作；手动检查仍可用。 */
    }
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req, srv) {
      const origin = req.headers.get('origin')
      const headers: Record<string, string> =
        origin && ORIGINS.has(origin)
          ? {
              'Access-Control-Allow-Origin': origin,
              'Access-Control-Allow-Headers': 'Authorization, Content-Type',
              'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
              Vary: 'Origin',
            }
          : {}
      if (origin && !ORIGINS.has(origin)) return new Response('forbidden', { status: 403 })
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers })
      const token = req.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''
      const address = srv.requestIP(req)?.address
      const supplied = Buffer.from(token)
      const expected = Buffer.from(key)
      if (
        address !== '127.0.0.1' ||
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      )
        return new Response('unauthorized', { status: 401, headers })
      const action = new URL(req.url).pathname.slice(1)
      if (action === 'status' && req.method === 'GET') return Response.json(state, { headers })
      if (req.method !== 'POST') return new Response('method not allowed', { status: 405, headers })
      if (action === 'cancel' && state.stage !== 'installing') {
        if (state.stage === 'downloading') downloadPaused = true
        job?.abort()
      } else if (action === 'check' || action === 'download' || action === 'install') {
        void run(action).catch((error: unknown) => {
          state.stage = 'error'
          state.error = String(error)
        })
      } else return new Response('invalid action', { status: 400, headers })
      return Response.json(state, { headers })
    },
  })
  const timer = setInterval(() => void autoCheck(), 15_000)
  timer.unref()
  void autoCheck()
  return {
    endpoint: { base: `http://127.0.0.1:${server.port}`, token: key },
    close() {
      closed = true
      job?.abort()
      clearInterval(timer)
      server.stop(true)
    },
  }
}
