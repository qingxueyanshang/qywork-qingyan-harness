/**
 * 创作广场：条目的类型、云端接口的数据形状与快照的校验。云端收到上传时与电脑端发布之前调用同一个
 * `checkSquareSnapshot`，两侧对同一份快照给出相同的结论；各类型的内容格式沿用电脑端已有的解析函数。
 *
 * 不变量：
 * - 一个版本是一份不可变的快照：文件按 SHA-256 保存，`meta` 只含该类型声明的字段。
 * - 快照中的路径是相对路径，以 `/` 分隔，没有空段、`.` 与 `..` 段，不含反斜杠与控制字符。
 * - MCP 配置中的 `env` 与 `headers` 只保留键，值须为空串：值通常是发布者的密钥。
 */

import { parsePersonalization } from './appearance/personalization.ts'
import { parsePetPack, petFrameFiles } from './appearance/pet.ts'
import { type CanvasNode, parseCanvas } from './canvas.ts'
import { type McpServerSpec, parseMcpConfig } from './mcp-config.ts'
import { mimeOf } from './model.ts'
import { isPanelEntry, parseManifest } from './plugin-manifest.ts'
import { isSkillDescription, parseSkillFrontmatter } from './skill.ts'

export const SQUARE_KINDS = [
  'work',
  'prompt',
  'canvas',
  'plugin',
  'skill',
  'mcp',
  'pet',
  'skin',
] as const

export type SquareKind = (typeof SQUARE_KINDS)[number]

/** 各类型的名称。电脑端的分类页签与后台的审核页共用。 */
export const SQUARE_KIND_LABEL: Record<SquareKind, string> = {
  work: '作品',
  prompt: '提示词',
  canvas: '画布',
  plugin: '插件',
  skill: '技能',
  mcp: 'MCP',
  pet: '宠物',
  skin: '皮肤',
}

export function isSquareKind(v: unknown): v is SquareKind {
  return (SQUARE_KINDS as readonly unknown[]).includes(v)
}

export type SquareStatus = 'pending' | 'approved' | 'rejected'

/** 作品的格式。 */
export type SquareWorkFormat = 'pptx' | 'video' | 'image'

/** 各类型的 `meta`。插件与技能的字段由快照中的清单得出，发布方不填写。 */
export interface SquareMetaByKind {
  work: { format: SquareWorkFormat; prompt?: string }
  prompt: { text: string }
  canvas: Record<string, never>
  plugin: { pluginId: string; name: string; version: string }
  skill: { name: string; description: string }
  mcp: { name: string; server: McpServerSpec }
  pet: Record<string, never>
  skin: Record<string, never>
}

export type SquareMeta = SquareMetaByKind[SquareKind]

export interface SquareFile {
  /** 快照内的相对路径。 */
  path: string
  /** 内容的 SHA-256（小写十六进制），`GET /v1/square/files/<hash>` 按它读取。 */
  hash: string
  size: number
  mime: string
}

/** 列表中的一个条目：最新的已上架版本。 */
export interface SquareCard {
  id: string
  kind: SquareKind
  title: string
  summary: string
  /** 发布者的用户名；GitHub 收录的条目为仓库（`owner/name`）。 */
  author: string
  /** 封面文件的哈希；没有封面时为 null。 */
  cover: string | null
  version: number
  /** 该版本通过审核的时刻。 */
  updatedAt: string
  source: 'upload' | 'github'
  repo: string | null
  license: string | null
}

export interface SquareDetail extends SquareCard {
  meta: SquareMeta
  files: SquareFile[]
  /** 本人发布的条目。 */
  mine: boolean
}

/** 本人发布的条目与其最新版本的审核状态。 */
export interface SquareMineItem {
  id: string
  kind: SquareKind
  title: string
  version: number
  status: SquareStatus
  /** 驳回原因；没有时为 null。 */
  note: string | null
  /** 有已上架的版本：新版本审核期间仍提供该版本。 */
  listed: boolean
  updatedAt: string
  /** GitHub 收录的条目没有手动发布的新版本：新版本由云端定时检查仓库的标签生成。 */
  source: 'upload' | 'github'
}

/** 可从 GitHub 仓库收录的类型：仓库（或其中的子目录）的内容即快照的布局。 */
export const SQUARE_GITHUB_KINDS = ['plugin', 'skill', 'pet', 'skin', 'canvas'] as const

export type SquareGithubKind = (typeof SQUARE_GITHUB_KINDS)[number]

/** 收录 GitHub 仓库的请求（`POST /v1/square/github`）。 */
export interface SquareGithubRequest {
  kind: SquareGithubKind
  /** `https://github.com/<owner>/<repo>` 或 `<owner>/<repo>`。 */
  url: string
  /** 标签或分支。 */
  ref: string
  /** 仓库内的子目录；缺省为仓库根目录。 */
  path?: string
  title: string
  summary: string
}

/**
 * 电脑端发布的来源，按类型：本机服务 `/api/square/publish` 的 `source`，由本机服务打包为快照。
 * 路径为当前项目中的工作区相对路径；技能为本机技能目录的绝对路径。
 */
export type SquarePublishSource =
  | { kind: 'prompt'; text: string }
  | { kind: 'work'; path: string; prompt?: string }
  | { kind: 'canvas'; path: string }
  | { kind: 'plugin'; id: string }
  | { kind: 'skill'; dir: string }
  | { kind: 'mcp'; name: string }
  | { kind: 'pet'; id: string }
  | { kind: 'skin' }

/** 发布请求中的清单（multipart 的 `manifest` 字段）。文件按 `files` 的顺序放在 `file:<序号>` 字段中。 */
export interface SquarePublishManifest {
  kind: SquareKind
  title: string
  summary: string
  meta: unknown
  files: { path: string }[]
}

export const SQUARE_LIMITS = {
  title: 60,
  summary: 500,
  text: 20_000,
  files: 500,
  pages: 200,
  /** 单个文件的字节上限，按类别。 */
  image: 20 * 1024 * 1024,
  video: 200 * 1024 * 1024,
  pptx: 100 * 1024 * 1024,
  other: 20 * 1024 * 1024,
  /** 一个版本全部文件的字节上限。 */
  total: 300 * 1024 * 1024,
} as const

/** 快照内的相对路径是否合法（见文件头的不变量）。 */
export function isSquarePath(path: string): boolean {
  if (path.length === 0 || path.length > 512) return false
  if (path.includes('\\') || /\p{Cc}/u.test(path)) return false
  return path.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
}

/** 按文件头判定类型所需的字节数：WebP 的标识位于第 8 至 11 字节。 */
export const SQUARE_HEAD_BYTES = 16

/**
 * 快照中的一个文件。校验只读取大小与开头的字节，云端接收的文件因此不必放入内存；
 * 该类型的定义文件（`SQUARE_DEFINITION`）的全部内容另行传入。
 */
export interface SnapshotFile {
  path: string
  size: number
  /** 文件开头的字节：至少 `SQUARE_HEAD_BYTES` 个，文件更短时为全部内容。 */
  head: Uint8Array
}

/** 各类型的定义文件：校验解析其全部内容，至多 `SQUARE_LIMITS.other` 字节。没有定义文件的类型为 null。 */
export const SQUARE_DEFINITION: Record<SquareKind, string | null> = {
  work: null,
  prompt: null,
  canvas: 'canvas.json',
  plugin: 'qywork.plugin.json',
  skill: 'SKILL.md',
  mcp: null,
  pet: 'pet.json',
  skin: 'skin.json',
}

export type SnapshotCheck =
  | {
      ok: true
      meta: SquareMeta
      /** 封面文件的路径；没有封面时为 null。 */
      cover: string | null
      /** 各文件的 MIME 类型，按路径。 */
      mime: Record<string, string>
    }
  | { ok: false; error: string }

const DECODER = new TextDecoder('utf-8', { fatal: true })

function text(bytes: Uint8Array): string | null {
  try {
    return DECODER.decode(bytes)
  } catch {
    return null
  }
}

function json(bytes: Uint8Array): unknown {
  const t = text(bytes)
  if (t === null) return undefined
  try {
    return JSON.parse(t)
  } catch {
    return undefined
  }
}

const starts = (b: Uint8Array, sig: readonly number[], at = 0) =>
  b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v)

/** 按文件头判定的图片类型；不是图片时为 null。 */
function imageMime(b: Uint8Array): string | null {
  if (starts(b, [0x89, 0x50, 0x4e, 0x47])) return 'image/png'
  if (starts(b, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (starts(b, [0x52, 0x49, 0x46, 0x46]) && starts(b, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp'
  }
  if (starts(b, [0x47, 0x49, 0x46, 0x38])) return 'image/gif'
  return null
}

/** 按文件头判定的视频类型（浏览器可直接播放的 mp4 与 webm）；不是时为 null。 */
function videoMime(b: Uint8Array): string | null {
  if (starts(b, [0x66, 0x74, 0x79, 0x70], 4)) return 'video/mp4'
  if (starts(b, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm'
  return null
}

const isZip = (b: Uint8Array) => starts(b, [0x50, 0x4b, 0x03, 0x04])

/** 按文件头判定的图片或视频的 MIME 类型；都不是时为 null。快照校验与电脑端提供文件内容时共用。 */
export function squareMediaMime(bytes: Uint8Array): string | null {
  return imageMime(bytes) ?? videoMime(bytes)
}

type Fail = { ok: false; error: string }
const fail = (error: string): Fail => ({ ok: false, error })
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const MB = (n: number) => `${n / 1024 / 1024} MB`

interface Checked {
  meta: SquareMeta
  cover: string | null
}

type Files = ReadonlyMap<string, SnapshotFile>

/** `definition` 为该类型定义文件的全部内容；快照中没有定义文件时为 null。 */
type KindCheck = (meta: unknown, files: Files, definition: Uint8Array | null) => Checked | Fail

/** 只允许列出的路径或前缀，且必须有 `required` 中的每一个。 */
function layout(
  files: Files,
  allowed: (path: string) => boolean,
  required: readonly string[],
): Fail | null {
  for (const path of files.keys()) {
    if (!allowed(path)) return fail(`快照中不应有该文件：${path}`)
  }
  for (const path of required) if (!files.has(path)) return fail(`快照中缺少 ${path}`)
  return null
}

function image(files: Files, path: string, max: number): Fail | null {
  const f = files.get(path)
  if (!f) return fail(`快照中缺少 ${path}`)
  if (!imageMime(f.head)) return fail(`${path} 不是 PNG、JPEG、WebP 或 GIF 图片`)
  if (f.size > max) return fail(`${path} 超过 ${MB(max)}`)
  return null
}

/**
 * 画布、宠物、皮肤的快照可以带其他文件（GitHub 仓库中的说明与许可证等），只要求用到的文件齐全；安装时只取用到的文件。
 */
const anyFile = () => true

const noFiles = (files: Files) => (files.size ? fail('该类型的快照不含文件') : null)

const KIND_CHECKS: Record<SquareKind, KindCheck> = {
  prompt(meta, files) {
    const bad = noFiles(files)
    if (bad) return bad
    if (!isObject(meta) || typeof meta.text !== 'string' || !meta.text.trim()) {
      return fail('提示词不能为空')
    }
    if (meta.text.length > SQUARE_LIMITS.text) {
      return fail(`提示词超过 ${SQUARE_LIMITS.text} 个字符`)
    }
    return { meta: { text: meta.text }, cover: null }
  },

  work(meta, files) {
    if (!isObject(meta) || !['pptx', 'video', 'image'].includes(meta.format as string)) {
      return fail('作品的 format 只能是 pptx、video 或 image')
    }
    const format = meta.format as SquareWorkFormat
    const prompt = meta.prompt
    if (
      prompt !== undefined &&
      (typeof prompt !== 'string' || prompt.length > SQUARE_LIMITS.text)
    ) {
      return fail(`提示词须为不超过 ${SQUARE_LIMITS.text} 个字符的文本`)
    }
    const out = { format, ...(typeof prompt === 'string' && prompt.trim() ? { prompt } : {}) }
    if (format === 'image') {
      const path = [...files.keys()].find((p) => /^image\.(png|jpe?g|webp|gif)$/.test(p))
      const bad =
        layout(files, (p) => p === path, path ? [] : ['image.png']) ??
        image(files, path ?? '', SQUARE_LIMITS.image)
      return bad ?? { meta: out, cover: path ?? null }
    }
    if (format === 'video') {
      const video = [...files.keys()].find((p) => /^video\.(mp4|webm)$/.test(p))
      const cover = [...files.keys()].find((p) => /^cover\.(png|jpe?g|webp)$/.test(p))
      const bad = layout(files, (p) => p === video || p === cover, [
        ...(video ? [] : ['video.mp4']),
        ...(cover ? [] : ['cover.png']),
      ])
      if (bad) return bad
      const v = files.get(video!)!
      if (!videoMime(v.head)) return fail(`${video} 不是 mp4 或 webm 视频`)
      if (v.size > SQUARE_LIMITS.video) return fail(`${video} 超过 ${MB(SQUARE_LIMITS.video)}`)
      return image(files, cover!, SQUARE_LIMITS.image) ?? { meta: out, cover: cover! }
    }
    const pages = [...files.keys()].filter((p) => /^pages\/\d+\.png$/.test(p)).length
    const bad = layout(files, (p) => p === 'deck.pptx' || /^pages\/[1-9]\d*\.png$/.test(p), [
      'deck.pptx',
      'pages/1.png',
    ])
    if (bad) return bad
    const deck = files.get('deck.pptx')!
    if (!isZip(deck.head)) return fail('deck.pptx 不是 PPTX 文件')
    if (deck.size > SQUARE_LIMITS.pptx) return fail(`deck.pptx 超过 ${MB(SQUARE_LIMITS.pptx)}`)
    if (pages > SQUARE_LIMITS.pages) return fail(`页面图片超过 ${SQUARE_LIMITS.pages} 张`)
    for (let n = 1; n <= pages; n++) {
      const problem = image(files, `pages/${n}.png`, SQUARE_LIMITS.image)
      if (problem) return problem
    }
    return { meta: out, cover: 'pages/1.png' }
  },

  canvas(_meta, files, definition) {
    const content = definition ? text(definition) : null
    if (content === null) return fail('快照中缺少 canvas.json')
    const parsed = parseCanvas(content)
    if (!parsed.ok) return fail(`canvas.json 不合法：${parsed.error}`)
    if (parsed.doc.runs?.length) return fail('canvas.json 中不应有生成记录')
    const refs = canvasFilePaths(parsed.doc)
    for (const ref of refs) {
      if (!isSquarePath(ref) || ref.endsWith('.task.json')) {
        return fail(`画布引用的路径不能发布：${ref}`)
      }
    }
    const bad = layout(
      files,
      anyFile,
      refs.map((r) => `files/${r}`),
    )
    if (bad) return bad
    for (const [path, f] of files) {
      const max = videoMime(f.head) ? SQUARE_LIMITS.video : SQUARE_LIMITS.other
      if (f.size > max) return fail(`${path} 超过 ${MB(max)}`)
    }
    const cover = refs.find((r) => imageMime(files.get(`files/${r}`)!.head) !== null)
    return { meta: {}, cover: cover ? `files/${cover}` : null }
  },

  plugin(_meta, files, definition) {
    if (!definition) return fail('快照中缺少 qywork.plugin.json')
    let manifest: ReturnType<typeof parseManifest>
    try {
      manifest = parseManifest(json(definition), 'qywork.plugin.json')
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
    for (const panel of manifest.contributes.panels ?? []) {
      if (!isPanelEntry(panel.entry) || !files.has(panel.entry)) {
        return fail(`工作台 ${panel.id} 的入口文件不存在：${panel.entry}`)
      }
    }
    return {
      meta: { pluginId: manifest.id, name: manifest.name, version: manifest.version },
      cover: null,
    }
  },

  skill(_meta, _files, definition) {
    const content = definition ? text(definition) : null
    if (content === null) return fail('快照中缺少 SKILL.md')
    const fm = parseSkillFrontmatter(content)
    if (!isSkillDescription(fm.description)) {
      return fail('SKILL.md 的 description 必须是非空的单行文本')
    }
    if (!fm.name) return fail('SKILL.md 缺少 name')
    return { meta: { name: fm.name, description: fm.description }, cover: null }
  },

  mcp(meta, files) {
    const bad = noFiles(files)
    if (bad) return bad
    if (
      !isObject(meta) ||
      typeof meta.name !== 'string' ||
      !/^[A-Za-z0-9_.-]{1,64}$/.test(meta.name)
    ) {
      return fail('MCP 的 name 须为 1 到 64 位字母、数字、点、横线或下划线')
    }
    if (!isObject(meta.server)) return fail('缺少 server 配置')
    for (const key of ['env', 'headers'] as const) {
      const values = meta.server[key]
      if (values === undefined) continue
      if (!isObject(values) || Object.values(values).some((v) => v !== '')) {
        return fail(`server 的 ${key} 只保留键，值须为空串`)
      }
    }
    const parsed = parseMcpConfig(JSON.stringify({ servers: { [meta.name]: meta.server } }))
    const server = parsed.servers[meta.name]
    if (!server || parsed.error) return fail(parsed.error ?? 'server 配置缺少 command 或 url')
    const { enabled: _enabled, ...spec } = server
    return { meta: { name: meta.name, server: spec }, cover: null }
  },

  pet(_meta, files, definition) {
    if (!definition) return fail('快照中缺少 pet.json')
    const parsed = parsePetPack(json(definition))
    if (!parsed.ok) return fail(`pet.json 不合法：${parsed.error}`)
    const frames = petFrameFiles(parsed.value)
    const bad = layout(files, anyFile, frames)
    if (bad) return bad
    for (const frame of frames) {
      if (files.get(frame)!.size > 4 * 1024 * 1024) return fail(`${frame} 超过 4 MB`)
    }
    return { meta: {}, cover: parsed.value.states.idle.frames[0] ?? null }
  },

  skin(_meta, files, definition) {
    if (!definition) return fail('快照中缺少 skin.json')
    const parsed = parsePersonalization(json(definition))
    if (!parsed.ok) return fail(`skin.json 不合法：${parsed.error}`)
    const bg = parsed.value.background
    const imagePath = bg.kind === 'image' ? bg.file : null
    const bad =
      layout(files, anyFile, imagePath ? [imagePath] : []) ??
      (imagePath ? image(files, imagePath, SQUARE_LIMITS.image) : null)
    return bad ?? { meta: {}, cover: imagePath }
  },
}

/** 画布引用的工作区文件：文件卡、生成卡各版本的产物与时间线片段的源视频，按首次出现去重。 */
export function canvasFilePaths(doc: { nodes: readonly CanvasNode[] }): string[] {
  const out = new Set<string>()
  for (const node of doc.nodes) {
    if (node.type === 'file') out.add(node.path)
    else if (node.type === 'generate') for (const v of node.versions) out.add(v.path)
    else for (const clip of node.clips) out.add(clip.path)
  }
  return [...out]
}

/**
 * 校验一份快照并得出 `meta` 与封面。云端在保存之前、电脑端在上传之前调用。
 * `definition` 为 `SQUARE_DEFINITION[kind]` 的全部内容，快照中没有该文件时为 null。
 */
export function checkSquareSnapshot(
  kind: SquareKind,
  meta: unknown,
  files: readonly SnapshotFile[],
  definition: Uint8Array | null,
): SnapshotCheck {
  if (files.length > SQUARE_LIMITS.files) return fail(`文件超过 ${SQUARE_LIMITS.files} 个`)
  const map = new Map<string, SnapshotFile>()
  let total = 0
  for (const f of files) {
    if (!isSquarePath(f.path)) return fail(`路径不合法：${f.path}`)
    if (map.has(f.path)) return fail(`路径重复：${f.path}`)
    map.set(f.path, f)
    total += f.size
  }
  if (total > SQUARE_LIMITS.total) return fail(`文件合计超过 ${MB(SQUARE_LIMITS.total)}`)
  const defPath = SQUARE_DEFINITION[kind]
  const def = defPath === null ? undefined : map.get(defPath)
  if (def && def.size > SQUARE_LIMITS.other) {
    return fail(`${defPath} 超过 ${MB(SQUARE_LIMITS.other)}`)
  }
  const checked = KIND_CHECKS[kind](meta, map, def ? definition : null)
  if ('ok' in checked) return checked
  const mime: Record<string, string> = {}
  for (const [path, f] of map) {
    mime[path] = squareMediaMime(f.head) ?? mimeOf(path)
  }
  return { ok: true, meta: checked.meta, cover: checked.cover, mime }
}

/** 内存中的文件按 `checkSquareSnapshot` 校验：电脑端发布之前调用。 */
export function checkSquareSnapshotBytes(
  kind: SquareKind,
  meta: unknown,
  files: readonly { path: string; bytes: Uint8Array }[],
): SnapshotCheck {
  const defPath = SQUARE_DEFINITION[kind]
  return checkSquareSnapshot(
    kind,
    meta,
    files.map((f) => ({
      path: f.path,
      size: f.bytes.length,
      head: f.bytes.subarray(0, SQUARE_HEAD_BYTES),
    })),
    files.find((f) => f.path === defPath)?.bytes ?? null,
  )
}

/** 标题与简介：去除首尾空白后非空，且不超过上限。 */
export function squareTextProblem(title: unknown, summary: unknown): string | null {
  if (typeof title !== 'string' || !title.trim()) return '标题不能为空'
  if (title.trim().length > SQUARE_LIMITS.title) return `标题超过 ${SQUARE_LIMITS.title} 个字符`
  if (typeof summary !== 'string') return '简介须为文本'
  if (summary.trim().length > SQUARE_LIMITS.summary) {
    return `简介超过 ${SQUARE_LIMITS.summary} 个字符`
  }
  return null
}
