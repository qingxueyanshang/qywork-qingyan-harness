/**
 * Office 工具分别提供操作说明、读取、制作与页面查看，共用一个执行程序（Python worker）。
 *
 * 模型编写 Python 制作脚本，由 `write` 执行；办公软件只以只读方式打开文件，用于重算、目录页码回填、导出与渲染，
 * 交付文件从不经由办公软件另存（WPS 另存会写入最近文档与账号打开记录，并重写整个文件包）。
 * 执行程序的位置与本机能力由宿主注入（`ctx.office`），没有可用的 Python 与文档库时本工具不注册。
 *
 * worker 的调用约定见 `office-worker.ts`。
 */

import { readFile, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
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
import { imageSizeOf } from '@qywork/core'
import { readHashes } from './files.ts'
import { landFiles } from './generate.ts'
import { downscaleNote, shrinkImage, zoomImage } from './image.ts'
import {
  noResponse,
  READ_TIMEOUT_MS,
  releaseCall,
  residueNote,
  runWorker,
  stageNote,
} from './office-worker.ts'
import {
  displayPath,
  resolveInWorkspace,
  resolveWritablePath,
  rootsOf,
  writableRoots,
} from './paths.ts'
import { redactSecrets } from './secrets.ts'
import { deliverReadable } from './sink.ts'

/** `write` 执行模型脚本并渲染整份文件，大文档导出需要数十秒；其余动作只读。 */
const WRITE_TIMEOUT_MS = 600_000

/**
 * 回执中保留的脚本输出长度，取末尾。写入未提交时调用目录保留至本轮结束，完整输出位于其中的
 * `response.json`；已提交的调用目录随即删除。
 */
const SCRIPT_OUTPUT_CHARS = 4000

const FORMATS = ['docx', 'pptx', 'xlsx'] as const
type Format = (typeof FORMATS)[number]

function formatOf(path: string): Format | null {
  const ext = extname(path).slice(1).toLowerCase()
  return (FORMATS as readonly string[]).includes(ext) ? (ext as Format) : null
}

/** view 另外接受 PDF 原件（worker 直接按页栅格化，不经过办公软件）；read、write 只接受 `FORMATS`。 */
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
  await releaseCall(run)
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
  await releaseCall(run)
  const res = run.response
  if (!res.ok) return { status: 'failure' as const, message: res.message + stageNote(res) }
  const sha = res.files?.[0]?.sha256
  // 记录读取时的版本：之后的 write 以它为预期版本，文件被其他程序修改时返回冲突。
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
        message: `${displayPath(ctx.workspaceRoot, abs)} 已存在但尚未读取。先用 read_office 读取，再修改。`,
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
  // 全部提交后工作副本与目标逐字节相同，调用目录不再有用；未提交时保留其中的候选文件。
  if (res.ok) await releaseCall(run)
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
      : `未写入${f.candidate ? `，候选文件位于 ${f.candidate}` : ''}`
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
      message: '当前模型不接受图片输入，无法查看页面。更换支持图片的模型后再查看。',
    }
  }
  const abs = await resolveInWorkspace(rootsOf(ctx), String(args.path ?? ''), { mustExist: true })
  if (!viewable(abs)) return failArgs('view 只处理 .docx、.pptx、.xlsx、.pdf 文件')
  const pages = stringList(args.pages)
  const region = regionOf(args.region)
  // 保存位置在渲染之前确定：越界、受保护或形式不对时不启动 worker。
  const save = await saveTarget(ctx, args.save_to, pages.length || 1)
  if (typeof save === 'string') return failArgs(save)
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
  const labels: string[] = []
  const saved: string[] = []
  let note = ''
  for (const [i, img] of res.images.entries()) {
    const raw = new Uint8Array(await readFile(img.path))
    if (save) {
      const key = img.key ?? request.pages[i] ?? String(i + 1)
      const target = 'file' in save ? save.file : join(save.dir, pageFileName(abs, key, !!region))
      const [landed] = await landFiles(rootsOf(ctx), [{ bytes: raw, mime: 'image/png' }], target)
      if (landed) saved.push(landed.path)
    }
    /*
     * 局部图放大到长边 MAX_EDGE（至多 ZOOM_MAX 倍）：worker 从原始渲染图裁出局部，区域小时只有
     * 一两百像素宽，原样发送与在整页缩小图上看没有区别。整页图缩小发送时写明尺寸，提示用 region。
     */
    const zoom = region
      ? await zoomImage(raw, { left: 0, top: 0, width: 1, height: 1 }).catch(() => null)
      : null
    const fit = zoom ?? (await shrinkImage(raw, 'image/png'))
    if (zoom && zoom.scale > 1.01) labels.push(`${img.label}（放大 ${zoom.scale.toFixed(1)} 倍）`)
    else labels.push(img.label)
    if (!region && !note)
      note = downscaleNote(imageSizeOf(raw), imageSizeOf(fit.bytes), 'view_office')
    // 余量不足以容纳一张图片时仍然投递，超出部分由下一次发送前的压缩回收（与 read_file 相同）。
    if (!chargeBatchBudget(ctx, MEDIA_TOKENS).ok) recordBatchSpent(ctx, MEDIA_TOKENS)
    images.push({ data: Buffer.from(fit.bytes).toString('base64'), mime: fit.mime })
  }
  await releaseCall(run)
  return {
    status: 'success' as const,
    message: `${displayPath(ctx.workspaceRoot, abs)}（sha256 ${request.expected_sha256.slice(0, 12)}）：${labels.join('、')}${
      note
        ? `
整页${note.slice(1)}`
        : ''
    }${saved.length ? `\n页面原图已保存：${saved.join('、')}` : ''}${residueNote(res)}`,
    data: { images },
    ...(saved.length
      ? { fileChanges: saved.map((path) => ({ path, changeType: 'created' as const })) }
      : {}),
  }
}

/**
 * `save_to` 指定的保存位置：以 .png 结尾为一个文件（只能保存一页），否则为目录。返回字符串 = 参数错误的说明。
 *
 * 与其他写入工具使用同一可写判定（`resolveWritablePath`：可写根与受保护目录）。写入经 `landFiles`：
 * 已存在的文件不覆盖，改名追加 -2、-3，回执写明实际位置。
 */
async function saveTarget(
  ctx: ToolContext,
  raw: unknown,
  pageCount: number,
): Promise<{ file: string } | { dir: string } | null | string> {
  const requested = typeof raw === 'string' ? raw.trim() : ''
  if (!requested) return null
  const abs = await resolveWritablePath(rootsOf(ctx), requested, { followFinalSymlink: false })
  const ext = extname(abs).toLowerCase()
  if (ext === '.png') {
    return pageCount > 1
      ? 'save_to 是 .png 文件时只能保存一页；保存多页时 save_to 写目录'
      : { file: abs }
  }
  if (['.jpg', '.jpeg', '.webp'].includes(ext)) {
    return '页面图为 PNG：save_to 写 .png 文件路径或目录'
  }
  const existing = await stat(abs).catch(() => null)
  if (existing && !existing.isDirectory()) {
    return `save_to 指向的 ${requested} 已存在且不是目录；保存一页时写 .png 文件路径，多页时写目录`
  }
  return { dir: abs }
}

/** 目录中每页的文件名：`<源文件名>-p<页码>.png`，xlsx 为 `<源文件名>-<工作表名>-<页码>.png`，局部图另加 `-region`。 */
function pageFileName(source: string, key: string, region: boolean): string {
  const tag = /^\d+$/.test(key) ? `p${key}` : key.replace(/[\\/:*?"<>|\s]+/g, '-')
  return `${basename(source, extname(source))}-${tag}${region ? '-region' : ''}.png`
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
        description: '脚本读取的文件（模板、素材、数据）',
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
    '交付文档前应查看页面，当前模型须支持图片输入。读取结构与文字使用 read_office。' +
    '页面要作为参考图使用时（如画布生成卡片的输入），用 save_to 把页面原图保存到工作区。',
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
        description: '页码，可一次提供多页，默认第 1 页；xlsx 写「工作表名:页码」',
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
        description:
          '可选，按页面比例（0 到 1）指定局部区域，从原始渲染图裁剪并放大到长边 1568（至多 4 倍）。' +
          '整页图缩小发送，细线、描边、残影、小字要用它放大后再判断',
      },
      save_to: {
        type: 'string',
        description:
          '可选，把渲染出的页面原图（PNG，渲染分辨率，不缩放；给出 region 时为局部原图）保存到工作区。' +
          '一页时可写 .png 文件路径；写目录时每页保存为「文件名-p页码.png」，多页时必须写目录。' +
          '已存在的文件不覆盖，改名追加 -2、-3，回执写明保存位置',
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
  // 给出 save_to 时向工作区写入页面图；权限效果须固定（工具清单按此列显示边界），因此声明为 write。
  permissionEffect: 'write',
  parallelSafe: false,
  resourceKeys: (a) => (typeof a.path === 'string' ? [`file:${a.path}`] : []),
  fn: withOffice(view),
}

export const officeTools = [readOfficeGuideTool, readOfficeTool, writeOfficeTool, viewOfficeTool]
