/**
 * Office worker 的调用约定：请求写入调用目录 `<会话临时目录>/office/<runId>/<调用>/<动作>-request.json`，
 * worker 在同目录写入 `response.json` 后以 0 退出。超时或取消时 worker 进程树被结束，但办公软件进程不在
 * 该进程树中，因此随后以 `cleanup` 动作再启动一次 worker，按调用目录中登记的实例处理残留进程。
 * `office` 工具、`read_file` 的视频抽帧与 `capture_canvas_frame` 的取帧共用此约定。
 *
 * 目录的生命周期：worker 给出结果且调用方读取完其中的文件后，调用方以 `releaseCall` 删除调用目录；
 * 写入未提交、超时、取消时保留，供本轮查看候选文件与处理残留进程。渲染缓存位于同一 run 目录下，
 * 本轮结束时删除整个 `office/<runId>`（该轮仍有后台任务时保留到任务结束之后，见 runtime 的 `releaseRunTemp`）。
 * 不要把缓存改为按会话或按工作区共用：
 * 每个中间版本都会留下一整套页面图片，且没有回收路径。
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chargeImage, type ToolContext, type ToolOutcome } from '@qywork/agent'
import { imageSizeOf } from '@qywork/core'
import { shrinkImage } from './image.ts'
import type { OfficePort } from './office/port.ts'
import { conversationTempDir, PROTECTED_DIRS } from './paths.ts'
import { collectProcess } from './process/collect.ts'
import type { SandboxPolicy } from './process/sandbox.ts'
import { spawnGuarded } from './process/spawn.ts'
import { redactSecrets } from './secrets.ts'
import { commandEnv } from './shell.ts'

/** 只读动作（read、view、frames、frame）的超时。 */
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
  /** `key` 是 view 渲染的页码（xlsx 为「工作表名:页码」），保存页面图时据此命名；frames 不提供。 */
  images?: { path: string; key?: string; label: string; width: number; height: number }[]
  /** frame 动作：截取的实际时间与视频时长（秒）；时长无法读取时为 null。 */
  frame?: { time: number; duration: number | null }
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

/**
 * 一次 worker 调用使用的上下文字段：工作区与临时目录的归属、沙箱的根目录、取消信号、凭证与环境变量。
 * 工具调用传入 `ToolContext`；画布生成的抽帧没有工具调用，由调用方按工作区构造（`sampleVideoFrames`）。
 */
export type WorkerScope = Pick<
  ToolContext,
  | 'workspaceRoot'
  | 'conversationId'
  | 'runId'
  | 'additionalDirectories'
  | 'denyNetwork'
  | 'signal'
  | 'secrets'
  | 'envAllowList'
  | 'unrestrictedPaths'
>

/** 启动一次 worker 并读取 `response.json`；超时、取消或未取得结果时以 `cleanup` 处理残留的办公软件进程。 */
export async function runWorker(
  ctx: WorkerScope,
  port: OfficePort,
  request: Record<string, unknown>,
  timeoutMs: number,
): Promise<WorkerRun> {
  const runDir = officeRunDir(ctx.workspaceRoot, ctx.conversationId, ctx.runId)
  const callDir = join(runDir, `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`)
  await mkdir(callDir, { recursive: true })
  const base = {
    call_dir: callDir,
    workspace: ctx.workspaceRoot,
    cache_dir: join(runDir, 'cache'),
  }
  // 模型代码在 worker 中执行，沙箱与路径边界使用与 `run_command` 相同的根目录清单。
  const policy: SandboxPolicy = {
    workspaceRoot: ctx.workspaceRoot,
    ...(ctx.additionalDirectories?.length ? { writableRoots: ctx.additionalDirectories } : {}),
    readOnlySubdirs: PROTECTED_DIRS,
    ...(ctx.denyNetwork ? { denyNetwork: true } : {}),
  }
  // 不写入 `__pycache__`：安装目录可能不可写，从源码运行时会在仓库中留下编译缓存。
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
    // 清理不受本次调用的取消信号控制：用户停止执行后，残留的办公软件进程仍需处理。
    // worker 结束的时刻随请求传入：其后启动的办公软件进程属于其他调用，清理不补登记它们。
    const workerEndedAt = Date.now() / 1000
    cleanup = (
      await invoke({ action: 'cleanup', worker_ended_at: workerEndedAt }, CLEANUP_TIMEOUT_MS)
    ).response
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

/**
 * Office 文件全部页面的 PNG（`view` 动作），按页码顺序。先渲染第 1 页取得页数，再取得全部页：渲染结果按文件哈希缓存在
 * 同一个 run 目录中，第二次调用不重复渲染。页数超过 `maxPages` 时不取得其余页，返回失败。
 * 用完后调用方删除 `officeRunDir(scope…)`。
 */
export async function renderOfficePages(
  scope: WorkerScope,
  port: OfficePort,
  abs: string,
  maxPages: number,
): Promise<{ ok: true; pages: Uint8Array[] } | { ok: false; message: string }> {
  const expected = createHash('sha256')
    .update(await readFile(abs))
    .digest('hex')
  const view = (pages: string[]) =>
    runWorker(
      scope,
      port,
      { action: 'view', path: abs, expected_sha256: expected, pages },
      READ_TIMEOUT_MS,
    )
  const first = await view(['1'])
  const count = first.response?.ok ? first.response.files?.[0]?.pages : null
  if (!count) return { ok: false, message: first.response?.message ?? noResponse(first).message }
  await releaseCall(first)
  if (count > maxPages) return { ok: false, message: `页数超过 ${maxPages} 页` }
  const all = await view(Array.from({ length: count }, (_, i) => String(i + 1)))
  const images = all.response?.ok ? all.response.images : null
  if (!images?.length)
    return { ok: false, message: all.response?.message ?? noResponse(all).message }
  const pages = await Promise.all(
    images.map(async (img) => new Uint8Array(await readFile(img.path))),
  )
  await releaseCall(all)
  return { ok: true, pages }
}

/** 一轮的 Office 目录：本轮各次调用的目录与渲染缓存。本轮结束时删除，该轮仍有后台任务时保留到任务结束之后。 */
export function officeRunDir(workspaceRoot: string, conversationId: string, runId: string): string {
  return join(conversationTempDir(workspaceRoot, conversationId), 'office', runId)
}

/**
 * 删除一次调用的目录。只在 worker 给出结果、调用方已读取完其中的文件之后调用。
 *
 * 删除失败（办公软件仍占用其中的文件）不影响本次结果：整个 run 目录在之后的一轮结束时再删除一次。
 */
export async function releaseCall(run: WorkerRun): Promise<void> {
  await rm(run.callDir, { recursive: true, force: true }).catch(() => {})
}

/** worker 未给出结果时的回执：说明超时、取消或崩溃，以及残留处理的结果。 */
export function noResponse(run: WorkerRun): ToolOutcome {
  const why = run.timedOut
    ? '执行超时，已结束执行程序'
    : run.aborted
      ? '已取消'
      : `执行程序未写出结果${run.stderr ? `：${run.stderr}` : ''}`
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

/** 按画面变化抽取的一帧：按图片发送的上限缩小后的字节、格式与时间（worker 写出的时刻文字）。 */
export interface SampledFrame {
  bytes: Uint8Array
  mime: string
  label: string
}

/**
 * worker 的 `frames` 动作：在区间内按画面变化提取一组带时间戳的帧，按时间顺序排列。`text` 是 worker 写给模型的说明。
 * 读取完帧之后删除调用目录。失败时 `outcome` 是 worker 未给出结果的回执（`noResponse`），
 * worker 报告失败时另有 `workerMessage`（其原因原文）。
 */
async function framesOf(
  scope: WorkerScope,
  port: OfficePort,
  abs: string,
  range: { start?: number; end?: number },
): Promise<
  | { ok: true; frames: SampledFrame[]; text: string }
  | { ok: false; outcome: ToolOutcome; workerMessage?: string }
> {
  const request = {
    action: 'frames',
    path: abs,
    ...(range.start !== undefined ? { start: range.start } : {}),
    ...(range.end !== undefined ? { end: range.end } : {}),
  }
  const run = await runWorker(scope, port, request, READ_TIMEOUT_MS)
  if (!run.response) return { ok: false, outcome: noResponse(run) }
  const res = run.response
  if (!res.ok || !res.images?.length) {
    return {
      ok: false,
      outcome: { status: 'failure', message: res.message },
      workerMessage: res.message,
    }
  }
  const frames: SampledFrame[] = []
  for (const img of res.images) {
    const fit = await shrinkImage(new Uint8Array(await readFile(img.path)), 'image/jpeg')
    frames.push({ bytes: fit.bytes, mime: fit.mime, label: img.label })
  }
  await releaseCall(run)
  return { ok: true, frames, text: res.text ?? '' }
}

/**
 * 视频按时间抽帧，作为图片返回（`read_file`）。
 *
 * 用于接受图片、不接受原生视频的模型。说明文字由 worker 生成：实际覆盖的时间点、最长的未覆盖区间、
 * 如何用 `read_file` 的 start/end 继续读取某一段，以及音频未处理。帧在回执中按时间顺序排列。
 */
export async function readVideoFrames(
  ctx: ToolContext,
  port: OfficePort,
  abs: string,
  shown: string,
  range: { start?: number; end?: number },
): Promise<ToolOutcome> {
  const read = await framesOf(ctx, port, abs, range)
  if (!read.ok) {
    return read.workerMessage === undefined
      ? read.outcome
      : {
          status: 'failure',
          message: `${shown}：${read.workerMessage}。不要更换参数重新读取该文件。`,
        }
  }
  const images = read.frames.map((f) => {
    chargeImage(ctx, imageSizeOf(f.bytes))
    return { data: Buffer.from(f.bytes).toString('base64'), mime: f.mime }
  })
  return { status: 'success', message: read.text, data: { images } }
}

/**
 * 整段视频按画面变化抽取的帧，供不接受原生视频的对话生成（画布的 art 卡与文本生成卡）作为图片发送。
 * 与 `read_file` 使用同一个 worker 动作；不扣除投递额度：生成请求不经过会话的投递预算。
 * worker 的说明文字指向 `read_file`，生成请求不带工具，因此不返回它，由调用方写明时长与尺寸。
 */
export async function sampleVideoFrames(
  scope: WorkerScope,
  port: OfficePort,
  abs: string,
): Promise<{ ok: true; frames: SampledFrame[] } | { ok: false; message: string }> {
  const read = await framesOf(scope, port, abs, {})
  return read.ok ? { ok: true, frames: read.frames } : { ok: false, message: read.outcome.message }
}

/** 截取的一帧：PNG 字节、实际时间与视频时长（秒，无法读取时为 null）、像素宽高。 */
export interface VideoFrame {
  png: Uint8Array
  time: number
  duration: number | null
  width: number
  height: number
}

/**
 * 视频在时间点 `at`（秒）处的一帧：worker 的 `frame` 动作按原尺寸写出 PNG，越界的时间点取首帧或尾帧。
 * 无法取得时返回失败回执。
 */
export async function grabVideoFrame(
  ctx: ToolContext,
  port: OfficePort,
  abs: string,
  shown: string,
  at: number,
): Promise<VideoFrame | ToolOutcome> {
  const run = await runWorker(ctx, port, { action: 'frame', path: abs, at }, READ_TIMEOUT_MS)
  if (!run.response) return noResponse(run)
  const res = run.response
  const image = res.images?.[0]
  if (!res.ok || !image || !res.frame)
    return { status: 'failure', message: `${shown}：${res.message}` }
  const png = new Uint8Array(await readFile(image.path))
  await releaseCall(run)
  return { png, ...res.frame, width: image.width, height: image.height }
}
