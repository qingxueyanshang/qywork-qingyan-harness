/**
 * Office worker 的调用约定：请求写进 `.tmp/office/<调用>/request.json`，worker 写回同目录的 `response.json`
 * 后以 0 退出。超时或取消时 worker 进程树被结束，办公软件进程不在其中，所以随后以 `cleanup`
 * 再起一次 worker，按调用目录里的实例登记处理残留。`office` 工具与 `read_file` 的视频抽帧共用这一条。
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  chargeBatchBudget,
  type OfficePort,
  recordBatchSpent,
  type ToolContext,
  type ToolOutcome,
} from '@qywork/agent'
import { MEDIA_TOKENS } from '@qywork/ai'
import { shrinkImage } from './image.ts'
import { PROTECTED_DIRS } from './paths.ts'
import { collectProcess, type SandboxPolicy, spawnGuarded } from './sandbox.ts'
import { redactSecrets } from './secrets.ts'
import { commandEnv } from './shell.ts'

/** 只读动作（read、view、frames）的超时。 */
export const READ_TIMEOUT_MS = 180_000
const CLEANUP_TIMEOUT_MS = 60_000

export interface WorkerStage {
  name: string
  file: string | null
  status: 'completed' | 'failed' | 'unavailable' | 'not_run'
  detail: string
}

export interface WorkerCheck {
  level: 'error' | 'warning' | 'info'
  code: string
  message: string
}

export interface WorkerFile {
  path: string
  committed: boolean
  sha256: string | null
  candidate: string | null
  pages: number | null
  sheets?: { name: string; pages: number; ranges: string[] }[] | null
  checks?: WorkerCheck[]
}

export interface WorkerResponse {
  ok: boolean
  action: string
  message: string
  stages?: WorkerStage[]
  files?: WorkerFile[]
  text?: string
  images?: { path: string; label: string; width: number; height: number }[]
  script_output?: string
  residue?: { pid: number; name: string; cmdline: string }[]
  errors?: string[]
}

export interface WorkerRun {
  response: WorkerResponse | null
  timedOut: boolean
  aborted: boolean
  stderr: string
  cleanup: WorkerResponse | null
  callDir: string
}

/** 起一次 worker 并收回 `response.json`；没收回时以 `cleanup` 处理残留的办公软件进程。 */
export async function runWorker(
  ctx: ToolContext,
  port: OfficePort,
  request: Record<string, unknown>,
  timeoutMs: number,
): Promise<WorkerRun> {
  const officeRoot = join(ctx.workspaceRoot, '.tmp', 'office')
  const callDir = join(officeRoot, `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`)
  await mkdir(callDir, { recursive: true })
  const base = {
    call_dir: callDir,
    workspace: ctx.workspaceRoot,
    cache_dir: join(officeRoot, 'cache'),
  }
  // 模型代码在 worker 里执行，沙箱与路径层用 `run_command` 的同一份根目录清单。
  const policy: SandboxPolicy = {
    workspaceRoot: ctx.workspaceRoot,
    ...(ctx.additionalDirectories?.length ? { writableRoots: ctx.additionalDirectories } : {}),
    readOnlySubdirs: PROTECTED_DIRS,
    ...(ctx.denyNetwork ? { denyNetwork: true } : {}),
  }
  // 不写 `__pycache__`：安装目录可能不可写，源码运行时会在仓库里留下编译缓存。
  const env = { ...(await commandEnv(ctx)), PYTHONDONTWRITEBYTECODE: '1' }

  const invoke = async (body: Record<string, unknown>, ms: number, signal?: AbortSignal) => {
    const reqPath = join(callDir, `${String(body.action)}-request.json`)
    await writeFile(reqPath, JSON.stringify({ ...base, ...body }), 'utf8')
    const { proc } = await spawnGuarded({
      argv: [port.python, port.worker, reqPath],
      cwd: ctx.workspaceRoot,
      env,
      policy,
    })
    const got = await collectProcess(proc, {
      timeoutMs: ms,
      ...(signal ? { signal } : {}),
      maxChars: 100_000,
    })
    const response = await readFile(join(callDir, 'response.json'), 'utf8')
      .then((t) => JSON.parse(t) as WorkerResponse)
      .catch(() => null)
    return { got, response }
  }

  const main = await invoke(request, timeoutMs, ctx.signal)
  const aborted = ctx.signal.aborted
  let cleanup: WorkerResponse | null = null
  if (main.got.timedOut || aborted || main.response === null) {
    // 清理不随本次调用的取消信号走：用户点了停止，残留的办公软件进程仍要处理。
    cleanup = (await invoke({ action: 'cleanup' }, CLEANUP_TIMEOUT_MS)).response
  }
  const secrets = ctx.secrets ?? { values: [] }
  return {
    response: main.response,
    timedOut: main.got.timedOut,
    aborted,
    stderr: redactSecrets(main.got.stderr.slice(-2000), secrets),
    cleanup,
    callDir,
  }
}

/** worker 没有给出结果时的回执：说明超时、取消或崩溃，以及残留处理的结果。 */
export function noResponse(run: WorkerRun): ToolOutcome {
  const why = run.timedOut
    ? '执行超时，已结束执行程序'
    : run.aborted
      ? '已取消'
      : `执行程序没有写出结果${run.stderr ? `：${run.stderr}` : ''}`
  const cleanup = run.cleanup ? `；残留处理：${run.cleanup.message}` : ''
  return {
    status: 'failure',
    message: `${why}${cleanup}。调用目录：${run.callDir}`,
    ...(run.timedOut ? { errorKind: 'timeout' } : {}),
  }
}

export function residueNote(res: WorkerResponse): string {
  if (!res.residue?.length) return ''
  const list = res.residue.map((r) => `${r.name}（PID ${r.pid}）`).join('、')
  return `\n开始前已存在的办公软件自动化进程：${list}。未处理。`
}

export function stageNote(res: WorkerResponse): string {
  const bad = (res.stages ?? []).filter((s) => s.status === 'failed' || s.status === 'unavailable')
  if (!bad.length) return ''
  return `\n未完成的阶段：\n${bad
    .map(
      (s) =>
        `- ${s.name}${s.file ? `（${s.file}）` : ''}：${s.status === 'failed' ? '失败' : '不可用'}，${s.detail}`,
    )
    .join('\n')}`
}

/**
 * 视频按时间抽帧：worker 的 `frames` 动作在区间里按画面变化取一组带时间戳的帧，作为图片返回。
 *
 * 给收图片、不收原生视频的模型用。说明由 worker 写：实际看到的时间点、最长的未看区间、
 * 怎么用 `read_file` 的 start/end 续读一段、声音没有处理。帧按时间顺序排在回执里。
 */
export async function readVideoFrames(
  ctx: ToolContext,
  port: OfficePort,
  abs: string,
  shown: string,
  range: { start?: number; end?: number },
): Promise<ToolOutcome> {
  const request = {
    action: 'frames',
    path: abs,
    ...(range.start !== undefined ? { start: range.start } : {}),
    ...(range.end !== undefined ? { end: range.end } : {}),
  }
  const run = await runWorker(ctx, port, request, READ_TIMEOUT_MS)
  if (!run.response) return noResponse(run)
  const res = run.response
  if (!res.ok || !res.images?.length) {
    return { status: 'failure', message: `${shown}：${res.message}。不要换参数重读这个文件。` }
  }
  const images: { data: string; mime: string }[] = []
  for (const img of res.images) {
    const raw = new Uint8Array(await readFile(img.path))
    const fit = await shrinkImage(raw, 'image/jpeg')
    // 余量放不下一张图时照样投递，超出的部分由下一次发送前的压缩收回（同 read_file 读图）。
    if (!chargeBatchBudget(ctx, MEDIA_TOKENS).ok) recordBatchSpent(ctx, MEDIA_TOKENS)
    images.push({ data: Buffer.from(fit.bytes).toString('base64'), mime: fit.mime })
  }
  // 帧已定格进回执，磁盘上那份不再有人读；不删的话每读一次视频就在工作区里留一批图。
  await rm(join(run.callDir, 'frames'), { recursive: true, force: true })
  return { status: 'success', message: res.text ?? '', data: { images } }
}
