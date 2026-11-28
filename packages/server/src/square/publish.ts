/**
 * 发布到创作广场：按类型把本机已有的内容打包为快照，以 `@qywork/core` 的 `checkSquareSnapshot` 校验（与云端保存前相同），
 * 再上传到云端（`POST /v1/square/items`，或发布者条目的 `POST /v1/square/items/:id/versions`）。
 * 快照中的文件从磁盘按块上传，校验只读取大小与开头的字节，文件不整体读入内存；上传按进展计时，不设总时长。
 *
 * 不变量：
 * - 快照只取本机已有、已通过本机校验的内容：已安装的插件与技能、配置中的 MCP、宠物库中的宠物、当前的皮肤、
 *   当前项目中的画布与文件。
 * - 发布者的密钥不进入快照：MCP 的 `env` 与 `headers` 只保留键；画布中自行添加接口的模型与各模型的参数选择被删除，
 *   只保留云端型号（所有账号相同）。
 * - 画布不含生成记录与待取回的版本（`.task.json`）。
 */

import { readdir, readFile, rm } from 'node:fs/promises'
import { extname, join, relative, sep } from 'node:path'
import { type MultipartField, multipartBody, UPLOAD_IDLE_MS } from '@qywork/ai'
import {
  artMediaRefs,
  type CanvasDoc,
  type CanvasGenerateNode,
  canvasFilePaths,
  checkSquareSnapshot,
  isSquareKind,
  type McpServerSpec,
  parseCanvas,
  petFrameFiles,
  resolveArtRef,
  SQUARE_DEFINITION,
  SQUARE_HEAD_BYTES,
  SQUARE_LIMITS,
  type SquareKind,
  type SquarePublishSource,
  serializeCanvas,
  squareTextProblem,
  TASK_SUFFIX,
} from '@qywork/core'
import {
  collectSecrets,
  globalPluginsDir,
  loadScopedMcpConfig,
  type OfficeHost,
  personalizationDir,
  petsDir,
  type QyConfig,
  readPersonalization,
  readPet,
} from '@qywork/runtime'
import {
  officeRunDir,
  renderOfficePages,
  resolveInWorkspace,
  scanAllSkills,
  scopeRoots,
} from '@qywork/tools'
import { CLOUD_PROVIDER, type CloudAccount } from '../cloud/account.ts'

export interface PublishInput {
  title: string
  summary: string
  source: SquarePublishSource
  /** 发布者已有的条目：给出时发布该条目的新版本。 */
  itemId?: string
  /** 视频作品的封面（PNG），由界面截取视频的首帧。 */
  cover?: Uint8Array
}

export interface PublishContext {
  account: CloudAccount
  config: QyConfig
  workspaceRoot: string
  office: OfficeHost | undefined
}

/** 打包得到的文件：磁盘上的文件（`Bun.file`），或打包时生成的内容（定义文件、封面）。 */
interface PackedFile {
  path: string
  file: Blob
}

/** `cleanup` 删除打包时生成的临时文件，在上传结束之后调用。 */
type Packed =
  | { ok: true; meta: unknown; files: PackedFile[]; cleanup?: () => Promise<void> }
  | { ok: false; error: string }

const generated = (path: string, content: string | Uint8Array): PackedFile => ({
  path,
  file: new Blob([content]),
})
/** 打包目录时跳过的目录：缓存与版本库。 */
const SKIPPED_DIRS = new Set(['__pycache__', '.pytest_cache', '.git'])

const fail = (error: string): Packed => ({ ok: false, error })

/** 目录中的全部普通文件，路径相对 `root`、以 `/` 分隔。符号链接与 `SKIPPED_DIRS` 不计入。 */
async function readTree(root: string, dir = root): Promise<PackedFile[]> {
  const out: PackedFile[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) out.push(...(await readTree(root, full)))
    } else if (entry.isFile()) {
      out.push({ path: relative(root, full).split(sep).join('/'), file: Bun.file(full) })
    }
  }
  return out
}

/** 删除自行添加接口的模型（卡片与各版本的生成记录）、各模型的参数选择与待取回的版本。 */
function publishable(node: CanvasGenerateNode): CanvasGenerateNode {
  const {
    provider: _provider,
    model: _model,
    paramsByModel: _byModel,
    current: _current,
    ...rest
  } = node
  const versions = node.versions
    .filter((v) => !v.path.endsWith(TASK_SUFFIX))
    .map((v) =>
      v.made.provider === CLOUD_PROVIDER
        ? v
        : { ...v, made: { ...v.made, provider: '', model: '' } },
    )
  const current = versions.some((v) => v.id === node.current) ? node.current : versions.at(-1)?.id
  return {
    ...rest,
    versions,
    ...(current ? { current } : {}),
    ...(node.provider === CLOUD_PROVIDER && node.model
      ? { provider: node.provider, model: node.model }
      : {}),
  }
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const VIDEO_EXT = new Set(['.mp4', '.webm'])

type Packers = {
  [K in SquareKind]: (
    src: Extract<SquarePublishSource, { kind: K }>,
    ctx: PublishContext,
    input: PublishInput,
  ) => Promise<Packed>
}

const PACKERS: Packers = {
  async prompt(src) {
    return { ok: true, meta: { text: src.text }, files: [] }
  },

  async work(src, ctx, input) {
    const abs = await resolveInWorkspace(ctx.workspaceRoot, src.path, { mustExist: true })
    const ext = extname(abs).toLowerCase()
    const meta = { ...(src.prompt?.trim() ? { prompt: src.prompt } : {}) }
    const file = Bun.file(abs)
    if (IMAGE_EXT.has(ext)) {
      return {
        ok: true,
        meta: { ...meta, format: 'image' },
        files: [{ path: `image${ext}`, file }],
      }
    }
    if (VIDEO_EXT.has(ext)) {
      if (!input.cover) return fail('缺少视频封面')
      return {
        ok: true,
        meta: { ...meta, format: 'video' },
        files: [{ path: `video${ext}`, file }, generated('cover.png', input.cover)],
      }
    }
    if (ext !== '.pptx') return fail('作品只能是图片、mp4 或 webm 视频、PPTX 文件')
    const port = ctx.office?.port()
    if (!port || !port.apps.pptx.available) {
      return fail(
        `无法渲染 PPT 的页面：${port?.apps.pptx.reason ?? '本机没有可用的 Office 文档功能'}`,
      )
    }
    const scope = {
      workspaceRoot: ctx.workspaceRoot,
      conversationId: 'square',
      runId: crypto.randomUUID(),
      signal: new AbortController().signal,
      secrets: collectSecrets(ctx.config),
    }
    const runDir = officeRunDir(scope.workspaceRoot, scope.conversationId, scope.runId)
    const cleanup = () => rm(runDir, { recursive: true, force: true })
    try {
      const pages = await renderOfficePages(
        scope,
        port,
        abs,
        SQUARE_LIMITS.pages,
        join(runDir, 'pages'),
      )
      if (!pages.ok) {
        await cleanup()
        return fail(`无法渲染 PPT 的页面：${pages.message}`)
      }
      return {
        ok: true,
        meta: { ...meta, format: 'pptx' },
        files: [
          { path: 'deck.pptx', file },
          ...pages.pages.map((page, i) => ({ path: `pages/${i + 1}.png`, file: Bun.file(page) })),
        ],
        cleanup,
      }
    } catch (err) {
      await cleanup()
      throw err
    }
  },

  async canvas(src, ctx) {
    const abs = await resolveInWorkspace(ctx.workspaceRoot, src.path, { mustExist: true })
    const parsed = parseCanvas(await readFile(abs, 'utf8'))
    if (!parsed.ok) return fail(parsed.error)
    const { runs: _runs, ...rest } = parsed.doc
    const doc: CanvasDoc = {
      ...rest,
      nodes: parsed.doc.nodes.map((n) => (n.type === 'generate' ? publishable(n) : n)),
    }
    const refs = new Set(canvasFilePaths(doc))
    // 各版本生成时的输入文件：存在时一并打包，导入后版本记录中的输入仍可打开；已删除的不计入。
    const inputs = doc.nodes.flatMap((n) =>
      n.type === 'generate' ? n.versions.flatMap((v) => v.made.inputs.map((i) => i.path)) : [],
    )
    for (const path of inputs) {
      if (
        await resolveInWorkspace(ctx.workspaceRoot, path, { mustExist: true }).catch(() => null)
      ) {
        refs.add(path)
      }
    }
    for (const ref of [...refs]) {
      if (!ref.toLowerCase().endsWith('.html')) continue
      const page = await resolveInWorkspace(ctx.workspaceRoot, ref, { mustExist: true }).catch(
        () => null,
      )
      const html = page ? await readFile(page, 'utf8').catch(() => null) : null
      if (html === null) continue
      for (const rel of artMediaRefs(html)) {
        const target = resolveArtRef(ref, rel)
        if (target) refs.add(target)
      }
    }
    const files: PackedFile[] = [generated('canvas.json', serializeCanvas(doc))]
    for (const ref of refs) {
      const file = await resolveInWorkspace(ctx.workspaceRoot, ref, { mustExist: true }).catch(
        () => null,
      )
      if (!file) return fail(`画布引用的文件不存在：${ref}`)
      files.push({ path: `files/${ref}`, file: Bun.file(file) })
    }
    return { ok: true, meta: {}, files }
  },

  async plugin(src) {
    if (/[\\/]|\.\./.test(src.id)) return fail(`插件 id 不合法：${src.id}`)
    return { ok: true, meta: {}, files: await readTree(join(globalPluginsDir(), src.id)) }
  },

  async skill(src, ctx) {
    const local = (await scanAllSkills(scopeRoots(ctx.workspaceRoot), [])).map((x) => x.item.dir)
    if (!local.includes(src.dir)) return fail('只能发布本机已安装的项目技能或全局技能')
    return { ok: true, meta: {}, files: await readTree(src.dir) }
  },

  async mcp(src, ctx) {
    const config = await loadScopedMcpConfig(ctx.workspaceRoot)
    const spec = config.servers[src.name]
    if (!spec) return fail(`没有名为 ${src.name} 的 MCP`)
    const { enabled: _enabled, ...server } = spec
    const blank = (values: Record<string, string> | undefined) =>
      values ? Object.fromEntries(Object.keys(values).map((k) => [k, ''])) : undefined
    const shared: McpServerSpec =
      'url' in server
        ? {
            transport: 'http',
            url: server.url,
            ...(server.headers ? { headers: blank(server.headers)! } : {}),
          }
        : {
            command: server.command,
            ...(server.args ? { args: server.args } : {}),
            ...(server.env ? { env: blank(server.env)! } : {}),
          }
    return { ok: true, meta: { name: src.name, server: shared }, files: [] }
  },

  async pet(src) {
    const entry = await readPet(src.id)
    if (!entry) return fail(`宠物不存在：${src.id}`)
    const frames = petFrameFiles(entry.pack)
    return {
      ok: true,
      meta: {},
      files: [
        generated('pet.json', JSON.stringify(entry.pack)),
        ...frames.map((f) => ({ path: f, file: Bun.file(join(petsDir(), src.id, f)) })),
      ],
    }
  },

  async skin() {
    const read = await readPersonalization()
    if (!read.ok) return fail(read.error)
    const value = read.entry.personalization
    const files: PackedFile[] = [generated('skin.json', JSON.stringify(value))]
    if (value.background.kind === 'image') {
      const file = value.background.file
      files.push({ path: file, file: Bun.file(join(personalizationDir(), file)) })
    }
    return { ok: true, meta: {}, files }
  },
}

const str = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

/** 请求中的来源；字段不合法时返回原因。 */
export function parsePublishSource(raw: unknown): SquarePublishSource | string {
  const o = (raw ?? {}) as Record<string, unknown>
  if (!isSquareKind(o.kind)) return '类型不合法'
  switch (o.kind) {
    case 'prompt':
      return typeof o.text === 'string' ? { kind: 'prompt', text: o.text } : '缺少提示词'
    case 'work':
      return str(o.path)
        ? {
            kind: 'work',
            path: o.path,
            ...(typeof o.prompt === 'string' ? { prompt: o.prompt } : {}),
          }
        : '缺少作品文件'
    case 'canvas':
      return str(o.path) ? { kind: 'canvas', path: o.path } : '缺少画布文件'
    case 'plugin':
      return str(o.id) ? { kind: 'plugin', id: o.id } : '缺少插件'
    case 'skill':
      return str(o.dir) ? { kind: 'skill', dir: o.dir } : '缺少技能'
    case 'mcp':
      return str(o.name) ? { kind: 'mcp', name: o.name } : '缺少 MCP'
    case 'pet':
      return str(o.id) ? { kind: 'pet', id: o.id } : '缺少宠物'
    case 'skin':
      return { kind: 'skin' }
  }
}

export type PublishResult =
  | { ok: true; id: string; version: number; status: string }
  | { ok: false; error: string }

/** 打包、校验并上传。校验不通过时不上传。 */
export async function publishToSquare(
  input: PublishInput,
  ctx: PublishContext,
): Promise<PublishResult> {
  const problem = squareTextProblem(input.title, input.summary)
  if (problem) return { ok: false, error: problem }
  const pack = PACKERS[input.source.kind] as (
    src: SquarePublishSource,
    ctx: PublishContext,
    input: PublishInput,
  ) => Promise<Packed>
  const packed = await pack(input.source, ctx, input)
  if (!packed.ok) return packed
  try {
    return await upload(input, ctx, packed.meta, packed.files)
  } finally {
    await packed.cleanup?.()
  }
}

/** 文件开头的 `SQUARE_HEAD_BYTES` 个字节（文件更短时为全部内容），只读取开头的一块。 */
async function headOf(file: Blob): Promise<Uint8Array> {
  const reader = file.stream().getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (size < SQUARE_HEAD_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.byteLength
    }
  } finally {
    await reader.cancel()
  }
  const head = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    head.set(c, at)
    at += c.byteLength
  }
  return head.subarray(0, SQUARE_HEAD_BYTES)
}

/** 校验快照（只读取各文件的大小与开头的字节，定义文件读取全部内容）并按流上传。 */
async function upload(
  input: PublishInput,
  ctx: PublishContext,
  meta: unknown,
  files: readonly PackedFile[],
): Promise<PublishResult> {
  const kind = input.source.kind
  const snapshot = await Promise.all(
    files.map(async (f) => ({
      path: f.path,
      size: f.file.size,
      head: await headOf(f.file),
    })),
  )
  const defPath = SQUARE_DEFINITION[kind]
  const def = files.find((f) => f.path === defPath)
  // 超过上限的定义文件不读取：校验按大小拒绝，不使用其内容。
  const definition = def
    ? def.file.size <= SQUARE_LIMITS.definition
      ? new Uint8Array(await def.file.arrayBuffer())
      : new Uint8Array()
    : null
  const checked = checkSquareSnapshot(kind, meta, snapshot, definition)
  if (!checked.ok) return checked
  const fields: MultipartField[] = [
    {
      name: 'manifest',
      value: JSON.stringify({
        kind,
        title: input.title.trim(),
        summary: input.summary.trim(),
        meta,
        files: files.map((f) => ({ path: f.path })),
      }),
    },
    ...files.map((f, i) => ({
      name: `file:${i}`,
      filename: f.path.split('/').pop() as string,
      type: checked.mime[f.path] ?? 'application/octet-stream',
      file: f.file,
    })),
  ]
  const body = multipartBody(fields)
  const path = input.itemId
    ? `/v1/square/items/${encodeURIComponent(input.itemId)}/versions`
    : '/v1/square/items'
  const res = await ctx.account.call<{ id: string; version: number; status: string }>(
    path,
    {
      method: 'POST',
      headers: { 'content-type': body.contentType, 'content-length': String(body.length) },
      body: body.body,
    },
    UPLOAD_IDLE_MS,
  )
  return { ok: true, ...res }
}
