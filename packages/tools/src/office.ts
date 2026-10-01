/**
 * `office` 工具：Word / PPT / Excel 的做法说明、读取、制作与看页，四个动作共用一个执行程序（Python worker）。
 *
 * 模型写 Python 制作脚本，`write` 执行它；办公软件只以只读方式打开文件做重算、目录页码回填、导出与渲染，
 * 交付件从不经办公软件另存（WPS 另存会写最近文档与账号打开记录，并重写整个文件包）。
 * 执行程序的位置与本机能力由宿主注入（`ctx.office`），没有可用的 Python 与文档库时本工具不注册。
 *
 * worker 的调用约定：请求写进 `.tmp/office/<调用>/request.json`，worker 写回同目录的 `response.json`
 * 后以 0 退出。超时或取消时 worker 进程树被结束，办公软件进程不在其中，所以随后以 `cleanup`
 * 再起一次 worker，按调用目录里的实例登记处理残留。
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import {
  chargeBatchBudget,
  type OfficePort,
  recordBatchSpent,
  type ToolContext,
  type ToolOutcome,
  type ToolSpec,
} from '@qywork/agent'
import { MEDIA_TOKENS } from '@qywork/ai'
import type { FileChange } from '@qywork/core'
import { readHashes } from './files.ts'
import { shrinkImage } from './image.ts'
import {
  displayPath,
  PROTECTED_DIRS,
  resolveInWorkspace,
  resolveWritablePath,
  rootsOf,
  writableRoots,
} from './paths.ts'
import { collectProcess, type SandboxPolicy, spawnGuarded } from './sandbox.ts'
import { redactSecrets } from './secrets.ts'
import { commandEnv } from './shell.ts'
import { deliverReadable } from './sink.ts'

/** `write` 执行模型脚本并渲染整份文件，大文档导出要几十秒；其余动作只读。 */
const WRITE_TIMEOUT_MS = 600_000
const READ_TIMEOUT_MS = 180_000
const CLEANUP_TIMEOUT_MS = 60_000

/** 回执里脚本输出的保留长度。完整输出在调用目录的 `response.json` 里。 */
const SCRIPT_OUTPUT_CHARS = 4000

const FORMATS = ['docx', 'pptx', 'xlsx'] as const
type Format = (typeof FORMATS)[number]

interface WorkerStage {
  name: string
  file: string | null
  status: 'completed' | 'failed' | 'unavailable' | 'not_run'
  detail: string
}

interface WorkerCheck {
  level: 'error' | 'warning' | 'info'
  code: string
  message: string
}

interface WorkerFile {
  path: string
  committed: boolean
  sha256: string | null
  candidate: string | null
  pages: number | null
  sheets?: { name: string; pages: number; ranges: string[] }[] | null
  checks?: WorkerCheck[]
}

interface WorkerResponse {
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

interface WorkerRun {
  response: WorkerResponse | null
  timedOut: boolean
  aborted: boolean
  stderr: string
  cleanup: WorkerResponse | null
  callDir: string
}

function formatOf(path: string): Format | null {
  const ext = extname(path).slice(1).toLowerCase()
  return (FORMATS as readonly string[]).includes(ext) ? (ext as Format) : null
}

/** view 另收 PDF 原件（worker 直接按页栅格化，不经过办公软件）；read、write 仍只认 `FORMATS`。 */
function viewable(path: string): boolean {
  return formatOf(path) !== null || extname(path).toLowerCase() === '.pdf'
}

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
}

/** 起一次 worker 并收回 `response.json`；没收回时以 `cleanup` 处理残留的办公软件进程。 */
async function runWorker(
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
function noResponse(run: WorkerRun): ToolOutcome {
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

function residueNote(res: WorkerResponse): string {
  if (!res.residue?.length) return ''
  const list = res.residue.map((r) => `${r.name}（PID ${r.pid}）`).join('、')
  return `\n开始前已存在的办公软件自动化进程：${list}。未处理。`
}

function stageNote(res: WorkerResponse): string {
  const bad = (res.stages ?? []).filter((s) => s.status === 'failed' || s.status === 'unavailable')
  if (!bad.length) return ''
  return `\n未完成的阶段：\n${bad
    .map(
      (s) =>
        `- ${s.name}${s.file ? `（${s.file}）` : ''}：${s.status === 'failed' ? '失败' : '不可用'}，${s.detail}`,
    )
    .join('\n')}`
}

async function guide(ctx: ToolContext, port: OfficePort, args: Record<string, unknown>) {
  const format = String(args.format ?? '')
  if (!(FORMATS as readonly string[]).includes(format)) {
    return failArgs('guide 需要 format：docx、pptx 或 xlsx')
  }
  const run = await runWorker(ctx, port, { action: 'guide', format }, READ_TIMEOUT_MS)
  if (!run.response) return noResponse(run)
  const text = run.response.text ?? ''
  return deliverReadable(ctx, {
    toolName: 'office',
    sourceType: 'office_guide',
    whole: { message: text },
    body: text,
    partial: (head, note) => ({ message: head + note }),
  })
}

async function read(ctx: ToolContext, port: OfficePort, args: Record<string, unknown>) {
  const abs = await resolveInWorkspace(rootsOf(ctx), String(args.path ?? ''), { mustExist: true })
  if (!formatOf(abs)) return failArgs('read 只处理 .docx、.pptx、.xlsx 文件')
  const request = {
    action: 'read',
    path: abs,
    ...(typeof args.range === 'string' && args.range ? { range: args.range } : {}),
  }
  const run = await runWorker(ctx, port, request, READ_TIMEOUT_MS)
  if (!run.response) return noResponse(run)
  const res = run.response
  if (!res.ok) return { status: 'failure' as const, message: res.message + stageNote(res) }
  const sha = res.files?.[0]?.sha256
  // 记下读到的那一版：之后的 write 以它为预期，文件被别处改过就返回冲突。
  if (sha) readHashes(ctx).set(abs, sha)
  const head = `${displayPath(ctx.workspaceRoot, abs)}\n`
  const text = res.text ?? ''
  return deliverReadable(ctx, {
    toolName: 'office',
    sourceType: 'office_read',
    whole: { message: head + text },
    body: text,
    partial: (part, note) => ({ message: head + part + note }),
  })
}

async function write(ctx: ToolContext, port: OfficePort, args: Record<string, unknown>) {
  const roots = rootsOf(ctx)
  const scriptArg = String(args.script ?? '')
  if (!scriptArg.toLowerCase().endsWith('.py')) return failArgs('script 须是工作区内的 .py 文件')
  const script = await resolveInWorkspace(writableRoots(roots), scriptArg, { mustExist: true })
  const inputs: string[] = []
  for (const p of stringList(args.inputs)) {
    inputs.push(await resolveInWorkspace(roots, p, { mustExist: true }))
  }
  const outputArgs = stringList(args.outputs)
  if (!outputArgs.length) return failArgs('write 需要 outputs：要生成或修改的 Office 文件')

  const seen = readHashes(ctx)
  const outputs: { path: string; expected_sha256: string | null }[] = []
  const existed = new Set<string>()
  for (const p of outputArgs) {
    const abs = await resolveWritablePath(roots, p)
    if (!formatOf(abs)) return failArgs(`${p} 不是 .docx、.pptx 或 .xlsx 文件`)
    const current = await readFile(abs).catch(() => null)
    if (current === null) {
      outputs.push({ path: abs, expected_sha256: null })
      continue
    }
    const expected = seen.get(abs)
    if (!expected) {
      return {
        status: 'failure' as const,
        executed: false,
        message: `${displayPath(ctx.workspaceRoot, abs)} 已存在但没读取过。先用 office(action=read) 读取，再修改。`,
      }
    }
    existed.add(abs)
    outputs.push({ path: abs, expected_sha256: expected })
  }
  const pdf: { source: string; path: string }[] = []
  if (args.export_pdf === true) {
    for (const o of outputs) {
      const target = `${o.path.slice(0, -extname(o.path).length)}.pdf`
      pdf.push({ source: o.path, path: await resolveWritablePath(roots, target) })
    }
  }

  const request = {
    action: 'write',
    script,
    inputs,
    outputs,
    update_toc: args.update_toc === true,
    pdf,
  }
  const run = await runWorker(ctx, port, request, WRITE_TIMEOUT_MS)
  if (!run.response) return noResponse(run)
  const res = run.response
  const fileChanges: FileChange[] = []
  const lines: string[] = []
  for (const f of res.files ?? []) {
    const shown = displayPath(ctx.workspaceRoot, f.path)
    if (f.committed && f.sha256) {
      seen.set(f.path, f.sha256)
      fileChanges.push({ path: shown, changeType: existed.has(f.path) ? 'modified' : 'created' })
    }
    const pages = f.sheets?.length
      ? f.sheets.map((s) => `${s.name} ${s.pages} 页`).join('，')
      : f.pages !== null
        ? `${f.pages} 页`
        : ''
    const state = f.committed
      ? `已写入${pages ? `（${pages}）` : ''}，sha256 ${f.sha256?.slice(0, 12)}`
      : `未写入${f.candidate ? `，候选在 ${f.candidate}` : ''}`
    lines.push(`- ${shown}：${state}`)
    for (const c of f.checks ?? []) {
      if (c.level !== 'info') lines.push(`  · [${c.level}] ${c.message}`)
    }
  }
  for (const p of pdf) {
    if (res.files?.some((f) => f.path === p.source && f.committed)) {
      fileChanges.push({ path: displayPath(ctx.workspaceRoot, p.path), changeType: 'created' })
    }
  }
  const secrets = ctx.secrets ?? { values: [] }
  const output = redactSecrets(res.script_output ?? '', secrets)
  const outputNote = output.trim()
    ? `\n脚本输出${output.length > SCRIPT_OUTPUT_CHARS ? `（末尾 ${SCRIPT_OUTPUT_CHARS} 字）` : ''}：\n${output.slice(-SCRIPT_OUTPUT_CHARS)}`
    : ''
  const message =
    `${res.message}\n${lines.join('\n')}` +
    stageNote(res) +
    residueNote(res) +
    outputNote +
    (res.ok ? '\n用 office(action=view) 查看页面。' : '')
  return {
    status: res.ok ? ('success' as const) : ('failure' as const),
    message,
    ...(fileChanges.length ? { fileChanges } : {}),
  }
}

async function view(ctx: ToolContext, port: OfficePort, args: Record<string, unknown>) {
  if (ctx.vision === false) {
    return {
      status: 'failure' as const,
      message: '当前模型不接受图片输入，看不了页面。换一个支持图片的模型再查看。',
    }
  }
  const abs = await resolveInWorkspace(rootsOf(ctx), String(args.path ?? ''), { mustExist: true })
  if (!viewable(abs)) return failArgs('view 只处理 .docx、.pptx、.xlsx、.pdf 文件')
  const pages = stringList(args.pages)
  const region = regionOf(args.region)
  const bytes = new Uint8Array(await readFile(abs))
  const request = {
    action: 'view',
    path: abs,
    expected_sha256: sha256(bytes),
    pages: pages.length ? pages : ['1'],
    region,
  }
  const run = await runWorker(ctx, port, request, WRITE_TIMEOUT_MS)
  if (!run.response) return noResponse(run)
  const res = run.response
  if (!res.ok || !res.images?.length) {
    return { status: 'failure' as const, message: res.message + stageNote(res) + residueNote(res) }
  }
  const images: { data: string; mime: string }[] = []
  for (const img of res.images) {
    const raw = new Uint8Array(await readFile(img.path))
    const fit = await shrinkImage(raw, 'image/png')
    // 余量放不下一张图时照样投递，超出的部分由下一次发送前的压缩收回（同 read_file）。
    if (!chargeBatchBudget(ctx, MEDIA_TOKENS).ok) recordBatchSpent(ctx, MEDIA_TOKENS)
    images.push({ data: Buffer.from(fit.bytes).toString('base64'), mime: fit.mime })
  }
  const labels = res.images.map((i) => i.label).join('、')
  return {
    status: 'success' as const,
    message: `${displayPath(ctx.workspaceRoot, abs)}（sha256 ${request.expected_sha256.slice(0, 12)}）：${labels}${residueNote(res)}`,
    data: { images },
  }
}

function stringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x ?? '').trim()).filter(Boolean)
  if (typeof v === 'string' && v.trim()) return [v.trim()]
  return []
}

function regionOf(v: unknown): { left: number; top: number; width: number; height: number } | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const n = (k: string) => Math.min(1, Math.max(0, Number(r[k])))
  const out = { left: n('left'), top: n('top'), width: n('width'), height: n('height') }
  return Object.values(out).every(Number.isFinite) && out.width > 0 && out.height > 0 ? out : null
}

function failArgs(message: string): ToolOutcome {
  return { status: 'failure', executed: false, message, errorKind: 'invalid_args' }
}

export const officeTool: ToolSpec = {
  name: 'office',
  description:
    '读取、制作、查看 Word / PPT / Excel 文件（.docx / .pptx / .xlsx）。' +
    '制作前先用 action=guide 取该格式的做法；把制作代码写成工作区里的 Python 脚本，用 action=write 执行；' +
    '之后用 action=view 看页面，有问题改脚本再 write。修改已有文件前先 action=read。' +
    'PDF 的页面（扫描件、图表、版式）也用 action=view 看。' +
    '技能里写的其他产品的执行方式（artifact-tool、soffice、shell 导出脚本等）只当做法参考，执行一律用本工具。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['guide', 'read', 'write', 'view'],
        description: 'guide：取做法说明；read：读结构与文字；write：执行制作脚本；view：看页面',
      },
      format: { type: 'string', enum: [...FORMATS], description: 'guide：说明的格式' },
      path: { type: 'string', description: 'read / view：文件的工作区相对路径；view 另收 .pdf' },
      range: {
        type: 'string',
        description: 'read：可选。docx 段落区间如 P1-P80；pptx 幻灯片区间如 2-5；xlsx 工作表名',
      },
      script: { type: 'string', description: 'write：制作脚本（.py）的工作区相对路径' },
      inputs: {
        type: 'array',
        items: { type: 'string' },
        description: 'write：脚本要读的文件（模板、素材、数据）',
      },
      outputs: {
        type: 'array',
        items: { type: 'string' },
        description: 'write：要生成或修改的 Office 文件；脚本用 office.output(路径) 取工作副本',
      },
      update_toc: { type: 'boolean', description: 'write：docx 按页面渲染结果回填目录页码' },
      export_pdf: { type: 'boolean', description: 'write：同时在每个输出旁导出同名 PDF' },
      pages: {
        type: 'array',
        items: { type: 'string' },
        description: 'view：页码，可一次给多页，默认第 1 页；xlsx 写「工作表名:页码」',
      },
      region: {
        type: 'object',
        properties: {
          left: { type: 'number' },
          top: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
        },
        required: ['left', 'top', 'width', 'height'],
        additionalProperties: false,
        description: 'view：可选，按页面比例（0 到 1）裁出局部，从原始渲染图裁取',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
  actionKind: (a) => (a.action === 'write' ? 'run' : a.action === 'guide' ? 'query' : 'read'),
  objectLabel: '文档',
  category: 'office',
  facet: '文档',
  summary: '读取、制作、查看 Word / PPT / Excel 文件',
  targetExtractor: (a) =>
    typeof a.path === 'string' ? a.path : (stringList(a.outputs)[0] ?? null),
  // 执行模型脚本的只有 write；它与 `run_command` 运行 Python 脚本同等放行。
  permissionEffect: (a) => (a.action === 'write' ? 'execute' : 'read'),
  parallelSafe: (a) => a.action === 'guide' || a.action === 'read',
  resourceKeys: (a) =>
    a.action === 'write'
      ? stringList(a.outputs).map((p) => `file:${p}`)
      : typeof a.path === 'string'
        ? [`file:${a.path}`]
        : [],
  async fn(args, ctx) {
    const port = ctx.office
    if (!port) {
      return { status: 'failure', executed: false, message: '本次执行没有 Office 执行程序' }
    }
    if (!port.enabled()) return { status: 'failure', executed: false, message: 'Office 文档已关闭' }
    switch (args.action) {
      case 'guide':
        return guide(ctx, port, args)
      case 'read':
        return read(ctx, port, args)
      case 'write':
        return write(ctx, port, args)
      case 'view':
        return view(ctx, port, args)
      default:
        return failArgs('action 须是 guide、read、write 或 view')
    }
  },
}
