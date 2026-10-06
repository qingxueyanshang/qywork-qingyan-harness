/**
 * Office 执行程序的宿主侧：查找 Python 解释器与 worker、探测本机能力、向会话提供端口。
 *
 * 服务端与 CLI 在进程启动时各创建一个，探测一次后缓存；会话按 `port()` 是否有值决定是否注册
 * `office`。开关（`officeEnabled`）在取得端口时与每次调用前各判定一次：关闭后本轮之后的调用被拒绝，
 * 下一轮起不再注册。
 * 探测结果同时供设置页的「Office 文档」分组与「运行环境」中的两行显示，三处读取同一份结果。
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import type { OfficePort } from '@qywork/agent'
import { collectProcess, scrubEnv } from '@qywork/tools'
import { collectSecrets, configDir, type QyConfig } from './config.ts'

const PROBE_TIMEOUT_MS = 60_000

type AppStatus = OfficePort['apps']['docx']

export interface OfficeStatus {
  enabled: boolean
  available: boolean
  /** 不可用时的原因；可用时为空串。 */
  reason: string
  python: string | null
  version: string | null
  /** 必需而缺失的 Python 包。 */
  missing: string[]
  /** 视频解码库 av 是否已安装。该库为可选依赖：缺少时仅视频抽帧不可用，不计入 `missing`。 */
  videoDecoder: boolean
  apps: OfficePort['apps'] | null
}

export interface OfficeHost {
  /** 重新探测。设置页安装依赖后调用；探测进行中再次调用时复用同一次探测。 */
  refresh(): Promise<OfficeStatus>
  status(): OfficeStatus
  /** 本轮可用时返回端口，否则返回 `undefined`（不注册工具）。 */
  port(): OfficePort | undefined
}

/**
 * worker 所在目录（资源根下的 `office/`）。
 *
 * 启动方显式指定时使用指定值（桌面外壳与开发脚本都设置 `QYWORK_OFFICE_DIR`）；否则按本程序的位置查找：
 * 安装目录中 `qy` 所在的目录，或源码运行时的 `packages/runtime/office/`。
 */
export function officeDir(): string | null {
  const candidates = [
    process.env.QYWORK_OFFICE_DIR,
    join(dirname(process.execPath), 'office'),
    join(import.meta.dir, '..', 'office'),
  ]
  for (const dir of candidates) {
    if (dir && existsSync(join(dir, 'worker.py'))) return dir
  }
  return null
}

/**
 * Python 解释器：配置中指定时使用指定值，否则在 PATH 中查找。
 *
 * Windows 上排除 `WindowsApps` 目录：该目录中的 `python.exe` 是商店别名，未安装 Python 时
 * 运行它会打开商店页面而不是报错。
 */
export function findPython(config: QyConfig): string | null {
  if (config.officePython) return existsSync(config.officePython) ? config.officePython : null
  const names = process.platform === 'win32' ? ['python.exe'] : ['python3', 'python']
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir || /[\\/]WindowsApps[\\/]?$/i.test(dir)) continue
    for (const name of names) {
      const full = join(dir, name)
      if (existsSync(full)) return full
    }
  }
  return null
}

const UNPROBED: OfficeStatus = {
  enabled: true,
  available: false,
  reason: '尚未探测',
  python: null,
  version: null,
  missing: [],
  videoDecoder: false,
  apps: null,
}

interface ProbeResult {
  python?: string
  missing?: string[]
  packages?: Record<string, string | null>
  apps?: Record<string, { available?: boolean; reason?: string }>
}

async function probe(python: string, dir: string, cfg: QyConfig): Promise<ProbeResult> {
  const callDir = join(configDir(), 'office', 'probe')
  await mkdir(callDir, { recursive: true })
  const reqPath = join(callDir, 'probe-request.json')
  await writeFile(
    reqPath,
    JSON.stringify({ action: 'probe', call_dir: callDir, workspace: callDir, cache_dir: callDir }),
    'utf8',
  )
  const proc = Bun.spawn([python, join(dir, 'worker.py'), reqPath], {
    cwd: callDir,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    // 探测只导入依赖、读取注册表，不执行模型代码；环境同样剥离凭证，与执行模型代码时的规则相同。
    env: {
      ...scrubEnv(process.env, collectSecrets(cfg)),
      PYTHONIOENCODING: 'utf-8',
      PYTHONDONTWRITEBYTECODE: '1',
    },
  })
  const got = await collectProcess(proc, { timeoutMs: PROBE_TIMEOUT_MS })
  if (got.timedOut) throw new Error('探测超时')
  const res = JSON.parse(await readFile(join(callDir, 'response.json'), 'utf8')) as {
    probe?: ProbeResult
  }
  if (!res.probe) throw new Error(`探测未返回结果：${got.stderr.slice(-400)}`)
  return res.probe
}

function appsOf(p: ProbeResult): OfficePort['apps'] {
  const one = (k: string): AppStatus => ({
    available: p.apps?.[k]?.available === true,
    reason: p.apps?.[k]?.reason ?? '',
  })
  return { docx: one('docx'), xlsx: one('xlsx'), pptx: one('pptx') }
}

export function createOfficeHost(config: () => QyConfig): OfficeHost {
  let current: OfficeStatus = UNPROBED
  let pending: Promise<OfficeStatus> | null = null
  let worker: string | null = null

  const enabled = () => config().officeEnabled !== false

  const run = async (): Promise<OfficeStatus> => {
    const dir = officeDir()
    const python = findPython(config())
    const base = { ...UNPROBED, enabled: enabled(), python }
    if (!dir) return { ...base, reason: '未找到 Office 执行程序（office/worker.py）' }
    if (!python) return { ...base, reason: '未找到 Python' }
    try {
      const p = await probe(python, dir, config())
      worker = join(dir, 'worker.py')
      const missing = p.missing ?? []
      return {
        ...base,
        available: missing.length === 0,
        reason: missing.length ? `缺少 Python 包：${missing.join('、')}` : '',
        version: p.python ?? null,
        missing,
        videoDecoder: typeof p.packages?.av === 'string',
        apps: appsOf(p),
      }
    } catch (err) {
      return {
        ...base,
        reason: `Python 探测失败：${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  return {
    refresh() {
      pending ??= run().then((s) => {
        current = s
        pending = null
        return s
      })
      return pending
    },
    status: () => ({ ...current, enabled: enabled() }),
    port() {
      if (!enabled() || !current.available || !current.python || !worker || !current.apps) {
        return undefined
      }
      return { python: current.python, worker, apps: current.apps, enabled }
    },
  }
}
