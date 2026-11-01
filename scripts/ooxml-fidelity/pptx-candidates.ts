/**
 * pptx 候选截图：按真值清单的幻灯片与尺寸，用 `@qywork/ooxml` 绘制并截图，输出到候选目录供 `fidelity.py score` 打分。
 *
 *   bun run scripts/ooxml-fidelity/pptx-candidates.ts [--only <文档标识>…] [--out <目录>]
 *
 * 分工与 xlsx 相同：本脚本（Bun）打包浏览器入口 `pptx-page.ts`，以本地 HTTP 服务提供页面、pptx 字节与本机字体；
 * `pptx-shoot.mjs`（Node）驱动 Playwright 打开 Edge，设备像素比 1，逐页调用 `renderPage` 并对画布截图。
 *
 * 真值清单的每页取 `file` 与幻灯片序号（`slide`，从 1 起；缺省为页序号 `n`），画布尺寸取真值图片的宽高。
 * 输出：`<out>/<文档标识>/<真值文件名>`，缺省输出目录为 `.tmp/ooxml-fidelity/candidates/ooxml-pptx`。
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractFace } from '../../packages/ooxml/src/font/index.ts'
import { facesFor, type IndexedFace, indexFonts } from './font-index.ts'

const ROOT = join(import.meta.dir, '..', '..')
const OUT = join(ROOT, '.tmp', 'ooxml-fidelity')

interface CorpusDoc {
  readonly id: string
  readonly path: string
  readonly format: string
}

interface TruthPage {
  readonly n: number
  readonly file: string
  readonly slide?: number
}

function parseArgs(argv: string[]): { only: string[]; out: string; truth: string } {
  const only: string[] = []
  let out = join(OUT, 'candidates', 'ooxml-pptx')
  let truth = join(OUT, 'truth')
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only') {
      while (argv[i + 1] && !argv[i + 1]!.startsWith('--')) only.push(argv[++i]!)
    } else if (argv[i] === '--out') {
      out = argv[++i] ?? out
    } else if (argv[i] === '--truth') {
      truth = argv[++i] ?? truth
    }
  }
  return { only, out, truth }
}

/** PNG 文件头中的宽高。 */
function pngSize(file: string): { width: number; height: number } {
  const b = readFileSync(file)
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

const { only, out, truth } = parseArgs(process.argv.slice(2))
const corpus = JSON.parse(readFileSync(join(OUT, 'corpus.json'), 'utf8')) as {
  documents: CorpusDoc[]
}
const truthTop = JSON.parse(readFileSync(join(truth, 'manifest.json'), 'utf8')) as {
  documents: { id: string; status: string }[]
}
const docs = corpus.documents.filter(
  (d) =>
    d.format === 'pptx' &&
    (only.length === 0 || only.includes(d.id)) &&
    truthTop.documents.some((t) => t.id === d.id && t.status === 'ok'),
)
const jobs = docs.map((d) => {
  const manifest = JSON.parse(readFileSync(join(truth, d.id, 'manifest.json'), 'utf8')) as {
    pages: TruthPage[]
  }
  return {
    id: d.id,
    pages: manifest.pages.map((p) => ({
      file: p.file,
      slide: p.slide ?? p.n,
      ...pngSize(join(truth, d.id, p.file)),
    })),
  }
})

const bundleDir = join(OUT, 'pptx-page')
const built = await Bun.build({
  entrypoints: [join(import.meta.dir, 'pptx-page.ts')],
  outdir: bundleDir,
  target: 'browser',
  format: 'esm',
  naming: 'page.js',
})
if (!built.success) {
  for (const log of built.logs) console.error(log)
  process.exit(1)
}

const fonts: IndexedFace[] = await indexFonts()
const faceIds = new Map<string, IndexedFace>()
for (const f of fonts) faceIds.set(`${f.file}#${f.index}`, f)

const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#fff">
<canvas id="slide" style="display:block"></canvas><script type="module" src="/page.js"></script>`

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/')
      return new Response(html, { headers: { 'content-type': 'text/html' } })
    if (url.pathname === '/page.js') return new Response(Bun.file(join(bundleDir, 'page.js')))
    if (url.pathname.startsWith('/doc/')) {
      const doc = docs.find((d) => d.id === decodeURIComponent(url.pathname.slice(5)))
      return doc ? new Response(Bun.file(doc.path)) : new Response('', { status: 404 })
    }
    if (url.pathname === '/font') {
      const list = facesFor(fonts, url.searchParams.get('name') ?? '')
      if (list.length === 0) return new Response('[]', { status: 404 })
      return Response.json(
        list.map((f) => ({ id: `${f.file}#${f.index}`, bold: f.bold, italic: f.italic })),
      )
    }
    if (url.pathname === '/font-face') {
      const face = faceIds.get(url.searchParams.get('id') ?? '')
      if (!face) return new Response('', { status: 404 })
      const bytes = new Uint8Array(await Bun.file(face.file).arrayBuffer())
      return new Response(extractFace(bytes, face.index).slice())
    }
    if (url.pathname === '/jobs') return Response.json(jobs)
    return new Response('', { status: 404 })
  },
})

mkdirSync(out, { recursive: true })
const node = Bun.spawn(
  ['node', join(import.meta.dir, 'pptx-shoot.mjs'), `http://127.0.0.1:${server.port}/`, out],
  { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' },
)
const code = await node.exited
server.stop(true)
process.exit(code)
