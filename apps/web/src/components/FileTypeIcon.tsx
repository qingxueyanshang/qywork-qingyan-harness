import { IconFile } from './Icons.tsx'

export type FileIconKind =
  | 'typescript'
  | 'javascript'
  | 'json'
  | 'markdown'
  | 'style'
  | 'markup'
  | 'python'
  | 'rust'
  | 'go'
  | 'java'
  | 'dotnet'
  | 'ruby'
  | 'php'
  | 'swift'
  | 'shell'
  | 'sql'
  | 'config'
  | 'docker'
  | 'image'
  | 'audio'
  | 'video'
  | 'pdf'
  | 'archive'
  | 'table'
  | 'document'
  | 'presentation'
  | 'database'
  | 'font'
  | 'lock'
  | 'text'
  | 'generic'

export interface FileIconSpec {
  kind: FileIconKind
  label: string
}

const TYPESCRIPT = new Set(['ts', 'tsx', 'mts', 'cts', 'tsbuildinfo'])
const JAVASCRIPT = new Set(['js', 'jsx', 'mjs', 'cjs'])
const MARKDOWN = new Set(['md', 'mdx', 'markdown'])
const STYLE = new Set(['css', 'scss', 'sass', 'less', 'styl'])
const MARKUP = new Set(['html', 'htm', 'xml', 'vue', 'svelte', 'astro'])
const SHELL = new Set(['sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd'])
const CONFIG = new Set(['yaml', 'yml', 'toml', 'ini', 'conf', 'config', 'properties', 'env'])
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg'])
const AUDIO = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'])
const VIDEO = new Set(['mp4', 'webm', 'mov', 'mkv', 'avi'])
const ARCHIVE = new Set(['zip', 'tar', 'gz', 'tgz', '7z', 'rar', 'xz', 'bz2', 'whl', 'jar'])
const TABLE = new Set(['csv', 'tsv', 'xlsx', 'xls', 'ods'])
const DOCUMENT = new Set(['doc', 'docx', 'odt', 'rtf'])
const PRESENTATION = new Set(['ppt', 'pptx', 'odp'])
const DATABASE = new Set(['db', 'sqlite', 'sqlite3'])
const FONT = new Set(['ttf', 'otf', 'woff', 'woff2', 'eot'])
const TEXT = new Set(['txt', 'log'])
const LOCK_NAMES = new Set([
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'cargo.lock',
  'poetry.lock',
  'composer.lock',
])

function basename(path: string): string {
  return path.replaceAll('\\', '/').split('/').pop()?.toLowerCase() ?? ''
}

function extension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1) : ''
}

export function fileIconSpec(path: string): FileIconSpec {
  const name = basename(path)
  const ext = extension(name)

  if (LOCK_NAMES.has(name)) return { kind: 'lock', label: 'L' }
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) {
    return { kind: 'docker', label: 'DK' }
  }
  if (name === 'makefile' || name === 'cmakelists.txt') return { kind: 'config', label: 'MK' }
  if (name === 'license' || name.startsWith('license.')) return { kind: 'text', label: '§' }
  if (name === 'readme' || name.startsWith('readme.')) return { kind: 'markdown', label: 'MD' }
  if (name === '.gitignore' || name === '.gitattributes' || name === '.gitmodules') {
    return { kind: 'config', label: 'GT' }
  }
  if (name === '.editorconfig' || name === '.npmrc' || name === '.prettierrc') {
    return { kind: 'config', label: 'CFG' }
  }

  if (TYPESCRIPT.has(ext)) return { kind: 'typescript', label: 'TS' }
  if (JAVASCRIPT.has(ext)) return { kind: 'javascript', label: 'JS' }
  if (ext === 'json' || ext === 'jsonc') return { kind: 'json', label: '{}' }
  if (MARKDOWN.has(ext)) return { kind: 'markdown', label: 'MD' }
  if (STYLE.has(ext)) return { kind: 'style', label: '#' }
  if (MARKUP.has(ext)) return { kind: 'markup', label: '<>' }
  if (ext === 'py' || ext === 'pyw') return { kind: 'python', label: 'PY' }
  if (ext === 'rs') return { kind: 'rust', label: 'RS' }
  if (ext === 'go') return { kind: 'go', label: 'GO' }
  if (ext === 'java' || ext === 'kt' || ext === 'kts') return { kind: 'java', label: 'JV' }
  if (ext === 'cs' || ext === 'fs' || ext === 'vb') return { kind: 'dotnet', label: 'C#' }
  if (ext === 'rb') return { kind: 'ruby', label: 'RB' }
  if (ext === 'php') return { kind: 'php', label: 'PHP' }
  if (ext === 'swift') return { kind: 'swift', label: 'SW' }
  if (SHELL.has(ext)) return { kind: 'shell', label: '>_' }
  if (ext === 'sql') return { kind: 'sql', label: 'SQL' }
  if (CONFIG.has(ext)) return { kind: 'config', label: 'CFG' }
  if (IMAGE.has(ext)) return { kind: 'image', label: ext === 'svg' ? 'SVG' : 'IMG' }
  if (AUDIO.has(ext)) return { kind: 'audio', label: 'AUD' }
  if (VIDEO.has(ext)) return { kind: 'video', label: 'VID' }
  if (ext === 'pdf') return { kind: 'pdf', label: 'PDF' }
  if (ARCHIVE.has(ext)) return { kind: 'archive', label: 'ZIP' }
  if (TABLE.has(ext))
    return { kind: 'table', label: ext === 'csv' || ext === 'tsv' ? 'CSV' : 'XLS' }
  if (DOCUMENT.has(ext)) return { kind: 'document', label: 'DOC' }
  if (PRESENTATION.has(ext)) return { kind: 'presentation', label: 'PPT' }
  if (DATABASE.has(ext)) return { kind: 'database', label: 'DB' }
  if (FONT.has(ext)) return { kind: 'font', label: 'F' }
  if (TEXT.has(ext)) return { kind: 'text', label: 'TXT' }

  return { kind: 'generic', label: '' }
}

export default function FileTypeIcon(props: { name: string }) {
  const spec = () => fileIconSpec(props.name)
  return (
    <span
      class="file-type-icon"
      data-file-kind={spec().kind}
      data-file-label={spec().label}
      aria-hidden="true"
    >
      {spec().kind === 'generic' ? <IconFile size={12} /> : <span>{spec().label}</span>}
    </span>
  )
}
