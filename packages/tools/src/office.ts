/**
 * Office 工具分别提供操作说明、读取、制作与页面查看，共用一个执行程序（Python worker）。
 *
 * 模型写 Python 制作脚本，`write` 执行它；办公软件只以只读方式打开文件做重算、目录页码回填、导出与渲染，
 * 交付件从不经办公软件另存（WPS 另存会写最近文档与账号打开记录，并重写整个文件包）。
 * 执行程序的位置与本机能力由宿主注入（`ctx.office`），没有可用的 Python 与文档库时本工具不注册。
 *
 * worker 的调用约定见 `office-worker.ts`。
 */

import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
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
import { noResponse, READ_TIMEOUT_MS, residueNote, runWorker, stageNote } from './office-worker.ts'
import {
  displayPath,
  resolveInWorkspace,
  resolveWritablePath,
  rootsOf,
  writableRoots,
} from './paths.ts'
import { redactSecrets } from './secrets.ts'
import { deliverReadable } from './sink.ts'

/** `write` 执行模型脚本并渲染整份文件，大文档导出要几十秒；其余动作只读。 */
const WRITE_TIMEOUT_MS = 600_000

/** 回执里脚本输出的保留长度。完整输出在调用目录的 `response.json` 里。 */
const SCRIPT_OUTPUT_CHARS = 4000

const FORMATS = ['docx', 'pptx', 'xlsx'] as const
type Format = (typeof FORMATS)[number]

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

async function guide(ctx: ToolContext, port: OfficePort, args: Record<string, unknown>) {
  const format = String(args.format ?? '')
  if (!(FORMATS as readonly string[]).includes(format)) {
    return failArgs('guide 需要 format：docx、pptx 或 xlsx')
  }
  const run = await runWorker(ctx, port, { action: 'guide', format }, READ_TIMEOUT_MS)
  if (!run.response) return noResponse(run)
  const text = run.response.text ?? ''
  return deliverReadable(ctx, {
    toolName: 'read_office_guide',
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
    toolName: 'read_office',
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
        message: `${displayPath(ctx.workspaceRoot, abs)} 已存在但没读取过。先用 read_office 读取，再修改。`,
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
    (res.ok ? '\n用 view_office 查看页面。' : '')
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

function withOffice(
  run: (ctx: ToolContext, port: OfficePort, args: Record<string, unknown>) => Promise<ToolOutcome>,
): ToolSpec['fn'] {
  return async (args, ctx) => {
    const port = ctx.office
    if (!port) {
      return { status: 'failure', executed: false, message: '本次执行没有 Office 执行程序' }
    }
    if (!port.enabled()) return { status: 'failure', executed: false, message: 'Office 文档已关闭' }
    return run(ctx, port, args)
  }
}

export const readOfficeGuideTool: ToolSpec = {
  name: 'read_office_guide',
  description:
    '获取 Word / PPT / Excel 文件的制作说明。制作前先读取对应格式的说明，' +
    '然后将制作代码保存为工作区中的 Python 脚本，用 write_office 执行，最后用 view_office 检查页面。',
  parameters: {
    type: 'object',
    properties: {
      format: { type: 'string', enum: [...FORMATS], description: '操作说明对应的格式' },
    },
    required: ['format'],
    additionalProperties: false,
  },
  actionKind: 'query',
  objectLabel: '文档',
  category: 'office',
  facet: '文档',
  summary: '获取 Word / PPT / Excel 制作说明',
  targetExtractor: (a) => (typeof a.format === 'string' ? a.format : null),
  permissionEffect: 'read',
  parallelSafe: true,
  fn: withOffice(guide),
}

export const readOfficeTool: ToolSpec = {
  name: 'read_office',
  description:
    '读取 Word / PPT / Excel 文件（.docx / .pptx / .xlsx）的结构与文字。' +
    '修改已有文件前必须先读取，用于写入时的版本冲突检查。查看页面使用 view_office。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件的工作区相对路径' },
      range: {
        type: 'string',
        description: '可选。docx 段落区间如 P1-P80；pptx 幻灯片区间如 2-5；xlsx 工作表名',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  actionKind: 'read',
  objectLabel: '文档',
  category: 'office',
  facet: '文档',
  summary: '读取 Word / PPT / Excel 的结构与文字',
  targetExtractor: (a) => (typeof a.path === 'string' ? a.path : null),
  permissionEffect: 'read',
  parallelSafe: true,
  resourceKeys: (a) => (typeof a.path === 'string' ? [`file:${a.path}`] : []),
  fn: withOffice(read),
}

export const writeOfficeTool: ToolSpec = {
  name: 'write_office',
  description:
    '执行工作区中的 Python 脚本，制作或修改 Word / PPT / Excel 文件（.docx / .pptx / .xlsx）。' +
    '先用 read_office_guide 获取该格式的操作说明；修改已有文件前先用 read_office 读取。' +
    '完成后用 view_office 检查页面，有问题时修改脚本再执行。' +
    '技能中描述的其他产品的执行方式（artifact-tool、soffice、shell 导出脚本等）仅作操作方法参考，执行一律使用本工具。',
  parameters: {
    type: 'object',
    properties: {
      script: { type: 'string', description: '制作脚本（.py）的工作区相对路径' },
      inputs: {
        type: 'array',
        items: { type: 'string' },
        description: '脚本要读的文件（模板、素材、数据）',
      },
      outputs: {
        type: 'array',
        items: { type: 'string' },
        description: '要生成或修改的 Office 文件；脚本用 office.output(路径) 获取工作副本',
      },
      update_toc: { type: 'boolean', description: 'docx 按页面渲染结果回填目录页码' },
      export_pdf: { type: 'boolean', description: '同时在每个输出旁导出同名 PDF' },
    },
    required: ['script', 'outputs'],
    additionalProperties: false,
  },
  actionKind: 'run',
  objectLabel: '文档',
  category: 'office',
  facet: '文档',
  summary: '执行脚本制作或修改 Word / PPT / Excel',
  targetExtractor: (a) => stringList(a.outputs)[0] ?? null,
  permissionEffect: 'execute',
  parallelSafe: false,
  resourceKeys: (a) => stringList(a.outputs).map((p) => `file:${p}`),
  fn: withOffice(write),
}

export const viewOfficeTool: ToolSpec = {
  name: 'view_office',
  description:
    '将 Word / PPT / Excel / PDF 文件的指定页面渲染为图片，用于检查版式、图表和扫描件。' +
    '交付文档前应查看页面，当前模型须支持图片输入。读取结构与文字使用 read_office。',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '文件的工作区相对路径，支持 .docx / .pptx / .xlsx / .pdf',
      },
      pages: {
        type: 'array',
        items: { type: 'string' },
        description: '页码，可一次给多页，默认第 1 页；xlsx 写「工作表名:页码」',
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
        description: '可选，按页面比例（0 到 1）裁出局部，从原始渲染图裁取',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  actionKind: 'read',
  objectLabel: '文档',
  category: 'office',
  facet: '文档',
  summary: '查看 Word / PPT / Excel / PDF 页面',
  targetExtractor: (a) => (typeof a.path === 'string' ? a.path : null),
  permissionEffect: 'read',
  parallelSafe: false,
  resourceKeys: (a) => (typeof a.path === 'string' ? [`file:${a.path}`] : []),
  fn: withOffice(view),
}

export const officeTools = [readOfficeGuideTool, readOfficeTool, writeOfficeTool, viewOfficeTool]
