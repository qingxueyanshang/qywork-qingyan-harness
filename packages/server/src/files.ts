/**
 * 文件浏览与预览。
 *
 * 「兼容所有格式」（需求 8）的实现策略是**分类而非穷举**：把文件归到几个渲染族
 * （文本/图片/PDF/音视频/表格/归档/二进制），每族一种渲染器，具体扩展名只影响
 * 语法高亮语言的选择。插件可以注册新的族或覆盖某扩展名的族——穷举扩展名的表
 * 永远追不上现实，而族是有限的。
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join, relative, sep } from 'node:path'
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
  /** 目录才有；懒加载，未展开时为 undefined。 */
  children?: FileNode[]
}

export interface PreviewResult {
  path: string
  kind: PreviewKind
  mime: string
  size: number
  /** 文本族才有。 */
  content?: string
  /** 语法高亮语言标识。 */
  language?: string
  /** 二进制族用 data URI 回传（有大小上限）。 */
  dataUri?: string
  truncated: boolean
  /** 无法内联时给出的说明，UI 直接显示。 */
  note?: string
}

/** 文本预览上限。超过就截断——把 5MB 的日志塞进浏览器只会把标签页卡死。 */
const MAX_TEXT_BYTES = 512 * 1024
/** 内联二进制上限（data URI 会膨胀约 1.37 倍）。 */
const MAX_INLINE_BYTES = 4 * 1024 * 1024

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
  '.svg': 'text', // SVG 既是图片也是文本；给文本以便直接编辑，UI 侧再叠加渲染
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

export async function listTree(
  workspaceRoot: string,
  relPath: string,
  depth: number,
): Promise<FileNode[]> {
  const abs = join(workspaceRoot, relPath)
  return walk(abs, workspaceRoot, depth)
}

async function walk(dir: string, root: string, depth: number): Promise<FileNode[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const out: FileNode[] = []

  for (const e of entries) {
    if (e.isDirectory() && IGNORED_DIRS.has(e.name)) continue
    if (e.name.startsWith('.') && e.name !== '.github' && e.name !== '.env.example') continue

    const abs = join(dir, e.name)
    const info = await stat(abs).catch(() => null)
    if (!info) continue

    const node: FileNode = {
      name: e.name,
      path: toPosix(relative(root, abs)),
      kind: e.isDirectory() ? 'dir' : 'file',
      size: info.size,
      mtime: info.mtimeMs,
    }
    if (e.isDirectory() && depth > 1) {
      node.children = await walk(abs, root, depth - 1)
    }
    out.push(node)
  }

  // 目录在前，同类按名排。和资源管理器/编辑器的直觉一致。
  out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
  return out
}

export async function preview(workspaceRoot: string, relPath: string): Promise<PreviewResult> {
  const abs = join(workspaceRoot, relPath)
  const info = await stat(abs)
  const { kind, mime, language } = classify(relPath)

  const base = {
    path: toPosix(relPath),
    kind,
    mime,
    size: info.size,
    truncated: false,
    ...(language ? { language } : {}),
  }

  if (kind === 'text' || kind === 'tabular') {
    // 表格族里 csv/tsv 是文本，xlsx 不是——按实际能否解码决定走哪条路。
    const buf = await readFile(abs)
    const slice = buf.subarray(0, MAX_TEXT_BYTES)
    const text = new TextDecoder('utf-8', { fatal: false }).decode(slice)
    if (looksBinary(text)) {
      return { ...base, kind: 'binary', truncated: false, note: '二进制内容，无法以文本预览' }
    }
    return { ...base, content: text, truncated: buf.length > MAX_TEXT_BYTES }
  }

  if (kind === 'image' || kind === 'pdf' || kind === 'audio' || kind === 'video') {
    if (info.size > MAX_INLINE_BYTES) {
      return {
        ...base,
        truncated: true,
        note: `文件 ${formatBytes(info.size)}，超出内联上限，请在本地打开`,
      }
    }
    const buf = await readFile(abs)
    return { ...base, dataUri: `data:${mime};base64,${buf.toString('base64')}` }
  }

  return { ...base, note: kind === 'archive' ? '归档文件' : '二进制文件' }
}

/** 控制字符密度判定。比嗅探魔数通用——覆盖所有未登记的格式。 */
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

function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

const toPosix = (p: string) => p.split(sep).join('/')
