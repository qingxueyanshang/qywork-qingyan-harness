/**
 * 文件浏览与预览。
 *
 * 支持所有格式的实现策略是分类而非穷举：把文件归入若干渲染族
 * （文本/图片/PDF/音视频/表格/归档/二进制），每族一种渲染器，具体扩展名只影响
 * 语法高亮语言的选择。插件可以注册新的族或覆盖某扩展名所属的族：扩展名表
 * 无法穷举所有格式，而族的数量是有限的。
 */

import { mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, sep } from 'node:path'
import { IGNORED_DIRS } from '@qywork/tools'

export type PreviewKind =
  | 'text'
  | 'image'
  | 'pdf'
  | 'audio'
  | 'video'
  | 'tabular'
  | 'archive'
  | 'binary'

export interface FileNode {
  name: string
  path: string
  kind: 'file' | 'dir'
  size: number
  mtime: number
  /** 仅目录有；懒加载，未展开时为 undefined。 */
  children?: FileNode[]
}

export interface PreviewResult {
  path: string
  kind: PreviewKind
  mime: string
  size: number
  /** 源文件修改时间。PDF、图片与音视频的字节另行获取（`openRaw`），界面据此判断是否重新获取。 */
  mtime: number
  /** 仅文本族有。 */
  content?: string
  /** 语法高亮语言标识。 */
  language?: string
  truncated: boolean
  /** 无法内联时给出的说明，UI 直接显示。 */
  note?: string
}

/** 文本预览上限。超过即截断：把 5MB 的日志载入浏览器会使标签页无响应。 */
const MAX_TEXT_BYTES = 512 * 1024

const EXT_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.jsonc': 'json',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.kt': 'kotlin',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.scala': 'scala',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.ps1': 'powershell',
  '.sql': 'sql',
  '.html': 'html',
  '.htm': 'html',
  '.xml': 'xml',
  '.svg': 'xml',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'toml',
  '.ini': 'ini',
  '.env': 'bash',
  '.dockerfile': 'dockerfile',
  '.lua': 'lua',
  '.r': 'r',
  '.dart': 'dart',
  '.ex': 'elixir',
  '.erl': 'erlang',
  '.hs': 'haskell',
  '.zig': 'zig',
  '.proto': 'protobuf',
  '.graphql': 'graphql',
}

const EXT_KIND: Record<string, PreviewKind> = {
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.bmp': 'image',
  '.ico': 'image',
  '.avif': 'image',
  '.svg': 'text', // SVG 既是图片也是文本；按文本返回以便直接编辑，由 UI 一侧叠加渲染
  '.pdf': 'pdf',
  '.mp3': 'audio',
  '.wav': 'audio',
  '.ogg': 'audio',
  '.flac': 'audio',
  '.m4a': 'audio',
  '.mp4': 'video',
  '.webm': 'video',
  '.mov': 'video',
  '.mkv': 'video',
  '.csv': 'tabular',
  '.tsv': 'tabular',
  '.zip': 'archive',
  '.tar': 'archive',
  '.gz': 'archive',
  '.7z': 'archive',
  '.rar': 'archive',
  '.xz': 'archive',
  '.whl': 'archive',
  '.jar': 'archive',
  '.xlsx': 'tabular',
  '.xls': 'tabular',
  '.ods': 'tabular',
}

const EXT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
}

export function classify(path: string): { kind: PreviewKind; mime: string; language?: string } {
  const ext = extname(path).toLowerCase()
  const kind = EXT_KIND[ext] ?? 'text'
  const mime = EXT_MIME[ext] ?? (kind === 'text' ? 'text/plain' : 'application/octet-stream')
  const language = EXT_LANGUAGE[ext]
  return { kind, mime, ...(language ? { language } : {}) }
}

/**
 * 界面文件树。磁盘上存在的条目全部列出，不做任何过滤。
 *
 * 不跳过 `node_modules` / `.git` / 构建产物，也不跳过以点开头的条目。该树是用户
 * 的文件浏览器，回答的问题是「工作区中有什么」。按名称隐藏部分条目，
 * 在界面上等同于它们不存在，而 `preview` 仍可读取、模型仍可修改。
 *
 * 模型侧的 `list_dir` / `glob` / `grep` 仍按 `IGNORED_DIRS` 跳过噪音目录，
 * 原因是 token 预算，而不是「该目录不存在」。两侧不一致时只允许一个方向：
 * 界面比模型显示得多。反之（界面隐藏、模型列出），用户无法核对模型的陈述。
 *
 * 按 depth 懒加载展开，因此全部列出不等于一次遍历整棵树：`node_modules` 同样只在展开时
 * 读取下一层。
 *
 * 本文件的读写函数均接收调用方已按工作区边界解析过的绝对路径，另接收一份用于显示的
 * 相对路径。不要在此处用 `join(workspaceRoot, rel)` 重新拼接：边界判定针对的是解析结果，
 * 重新拼接得到的是另一个路径。节点路径由相对路径段拼接，不对解析结果取 `relative`，
 * 因为解析结果已解析软链接，工作区根本身是软链接或 junction 时两者不同根。
 */
export async function listTree(dir: string, relPath: string, depth: number): Promise<FileNode[]> {
  return walk(dir, relPath, depth)
}

async function walk(dir: string, rel: string, depth: number): Promise<FileNode[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const out: FileNode[] = []

  for (const e of entries) {
    const abs = join(dir, e.name)
    const info = await stat(abs).catch(() => null)
    if (!info) continue

    const path = toPosix(join(rel, e.name))
    const node: FileNode = {
      name: e.name,
      path,
      kind: e.isDirectory() ? 'dir' : 'file',
      size: info.size,
      mtime: info.mtimeMs,
    }
    if (e.isDirectory() && depth > 1) {
      node.children = await walk(abs, path, depth - 1)
    }
    out.push(node)
  }

  // 目录在前，同类按名称排序，与资源管理器、编辑器的惯例一致。
  out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
  return out
}

/** 目标已存在。调用方须将其转换为 409：不覆盖是该接口的硬性约定。 */
export class EntryExistsError extends Error {
  constructor(readonly relPath: string) {
    super(`${relPath} 已存在`)
    this.name = 'EntryExistsError'
  }
}

/**
 * 新建文件或目录。创建空文件、空目录，不带模板。
 *
 * 先判定是否存在再写入：`mkdir` 的 `recursive` 对已存在的目录静默成功，依赖它判定
 * 会使「新建」与「未做任何操作」返回同一结果。文件分支另加 `wx`，
 * 拦截判定与写入之间被其他进程抢先创建的情形。
 *
 * 中间目录一并创建（`docs/a/b.md` 中的 `docs/a`）：这是用户在输入框中
 * 输入的路径，缺少中间目录即报错等于要求用户逐层创建。
 */
export async function createEntry(
  abs: string,
  relPath: string,
  kind: 'file' | 'dir',
): Promise<FileNode> {
  const taken = await stat(abs).catch(() => null)
  if (taken) throw new EntryExistsError(relPath)

  if (kind === 'dir') await mkdir(abs, { recursive: true })
  else {
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, '', { flag: 'wx' })
  }

  const info = await stat(abs)
  return {
    name: basename(abs),
    path: toPosix(relPath),
    kind,
    size: info.size,
    mtime: info.mtimeMs,
  }
}

/**
 * 改名。只更改名称，不移动位置：目标始终是同一父目录下的另一个名称。
 *
 * 名称合法性由调用方预先判定（不能含分隔符、不能是 `.` / `..`）：那是入参校验，
 * 属于边界层。此处只处理「新名称已被占用」这一种情形，与 `createEntry` 规则相同。
 */
export async function renameEntry(abs: string, relPath: string, name: string): Promise<FileNode> {
  const nextRel = toPosix(join(dirname(relPath), name))
  const nextAbs = join(dirname(abs), name)

  const taken = await stat(nextAbs).catch(() => null)
  // 改名前后可能指向同一目标：Windows 上不区分大小写，`a.ts` → `A.ts` 会被
  // 判定为「已存在」而拒绝，因此只有目标确实改变时才算冲突。
  if (taken && nextAbs !== abs) throw new EntryExistsError(nextRel)

  await rename(abs, nextAbs)
  const info = await stat(nextAbs)
  return {
    name,
    path: nextRel,
    kind: info.isDirectory() ? 'dir' : 'file',
    size: info.size,
    mtime: info.mtimeMs,
  }
}

/**
 * 删除。删除目录时一并删除其内容。
 *
 * `force: false` 是有意设置：不存在时必须抛出，使上层返回 404。`force: true` 会把
 * 「已删除」与「原本不存在」视为同一结果，而用户执行删除操作后需要确认是否已删除。
 */
export async function deleteEntry(abs: string): Promise<void> {
  await rm(abs, { recursive: true, force: false })
}

export interface FindHit {
  path: string
  kind: 'file' | 'dir'
}

/** 单次搜索最多返回的命中数与最多遍历的条目数。达到任一上限即视为截断。 */
const FIND_MAX_HITS = 300
const FIND_MAX_ENTRIES = 20_000

/**
 * 按名称查找文件。子串匹配，不区分大小写。
 *
 * 此处跳过 `IGNORED_DIRS`，与文件树不同，理由是搜索结果必须可用：文件树不过滤，
 * 因此工作区第一层即有 `node_modules`；按字典序遍历时预算会在依赖树中
 * 耗尽，用户搜索 `launch` 无法取得任何命中。界面必须说明该边界
 * （空结果所在行），否则空结果会被理解为文件不存在。
 *
 * 广度优先：浅层结果先返回。用户查找的文件通常位于前两三层，而深层的同名文件
 * 排在前面会占满结果列表。
 *
 * 只调用 `readdir` 不调用 `stat`：命中列表不显示大小与时间，为两万个条目各取一次元数据
 * 会额外耗费数百毫秒。
 *
 * 提供 `accept`（工作区相对路径 → 是否接受）时只返回其接受的文件、不返回目录；此时查询
 * 允许为空，返回其接受的全部文件，同样受两个上限约束。
 */
export async function findByName(
  workspaceRoot: string,
  query: string,
  limits: { hits: number; entries: number } = { hits: FIND_MAX_HITS, entries: FIND_MAX_ENTRIES },
  accept?: (path: string) => boolean,
): Promise<{ matches: FindHit[]; truncated: boolean }> {
  // 没有 `accept` 时空查询返回空结果，判定放在此处而不是调用方：空字符串表示「匹配全部」，
  // 若由 HTTP 层拦截，新接入的其他调用方会取得整棵树。
  const needle = query.trim().toLowerCase()
  if (!needle && !accept) return { matches: [], truncated: false }

  const matches: FindHit[] = []
  let scanned = 0
  let truncated = false
  const queue: string[] = [workspaceRoot]

  while (queue.length > 0) {
    const dir = queue.shift()!
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (matches.length >= limits.hits || scanned >= limits.entries) {
        truncated = true
        return { matches, truncated }
      }
      scanned++
      const abs = join(dir, e.name)
      const path = toPosix(relative(workspaceRoot, abs))
      const named = e.name.toLowerCase().includes(needle)
      const kept = !accept || (!e.isDirectory() && accept(path))
      if (named && kept) matches.push({ path, kind: e.isDirectory() ? 'dir' : 'file' })
      if (e.isDirectory() && !IGNORED_DIRS.has(e.name)) queue.push(abs)
    }
  }
  return { matches, truncated }
}

export async function preview(abs: string, relPath: string): Promise<PreviewResult> {
  const info = await stat(abs)
  const { kind, mime, language } = classify(relPath)

  const base = {
    path: toPosix(relPath),
    kind,
    mime,
    size: info.size,
    mtime: info.mtimeMs,
    truncated: false,
    ...(language ? { language } : {}),
  }

  /*
   * PDF、图片与音视频不内联，字节由 `openRaw` 另行提供。不要改为 data URI：桌面端 CSP 的
   * `frame-src` 只允许 `blob:`，data URI 的 iframe 在打包版中显示空白；内联还需把整份文件以
   * base64 写入该 JSON 响应，生成的 4K 图片与视频常超过数 MB，只能截断而无法显示。
   */
  if (kind === 'pdf' || kind === 'image' || kind === 'audio' || kind === 'video') return base

  if (kind === 'text' || kind === 'tabular') {
    // 表格族中 csv/tsv 是文本，xlsx 不是：按实际能否解码决定处理路径。
    // 只读取上限以内的字节：整文件读入后再截断，内存占用会随文件大小增长。
    const text = new TextDecoder('utf-8', { fatal: false }).decode(
      await readHead(abs, MAX_TEXT_BYTES),
    )
    if (looksBinary(text)) {
      return { ...base, kind: 'binary', truncated: false, note: '二进制内容，无法以文本预览' }
    }
    return { ...base, content: text, truncated: info.size > MAX_TEXT_BYTES }
  }

  return { ...base, note: kind === 'archive' ? '归档文件' : '二进制文件' }
}

/** 文件的原始字节与类型。目录返回 `null`。字节以流读取，不整份载入内存。 */
export async function openRaw(
  abs: string,
  relPath: string,
): Promise<{ body: Blob; mime: string } | null> {
  const info = await stat(abs)
  if (!info.isFile()) return null
  return { body: Bun.file(abs), mime: classify(relPath).mime }
}

async function readHead(abs: string, limit: number): Promise<Uint8Array> {
  const handle = await open(abs, 'r')
  try {
    const buf = new Uint8Array(limit)
    const { bytesRead } = await handle.read(buf, 0, limit, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/** 按控制字符密度判定。比嗅探魔数更通用，覆盖所有未登记的格式。 */
function looksBinary(sample: string): boolean {
  if (!sample) return false
  let control = 0
  const n = Math.min(sample.length, 4096)
  for (let i = 0; i < n; i++) {
    const c = sample.charCodeAt(i)
    if (c === 0) return true
    if (c < 9 || (c > 13 && c < 32)) control++
  }
  return control / n > 0.1
}

const toPosix = (p: string) => p.split(sep).join('/')
