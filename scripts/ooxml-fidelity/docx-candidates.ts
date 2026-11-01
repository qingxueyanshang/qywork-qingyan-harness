/**
 * docx 候选截图：用 `@qywork/ooxml` 分页并逐页绘制、截图，输出到候选目录供 `fidelity.py score` 打分。
 *
 *   bun run scripts/ooxml-fidelity/docx-candidates.ts [--only <文档标识>…] [--out <目录>]
 *
 * 分工：本脚本（Bun）打包浏览器入口 `docx-page.ts`，并以本地 HTTP 服务提供页面、docx 字节与本机字体；
 * `docx-shoot.mjs`（Node）驱动 Playwright 打开 Edge，设备像素比 1，逐页调用 `renderPage` 并对画布截图。
 * 画布尺寸取真值清单中该页的像素尺寸，页数以真值为准：本方页数不足时缺页由打分记 0 分，多出的页不输出。
 *
 * 输出：`<out>/<文档标识>/page-0001.png` 起，文件名与真值清单一致。缺省输出目录为
 * `.tmp/ooxml-fidelity/candidates/ooxml-docx`。另写 `<out>/<文档标识>/pages.json`：本方页数与每页的表格、浮动对象个数。
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
  readonly width: number
  readonly height: number
}

function parseArgs(argv: string[]): { only: string[]; out: string } {
  const only: string[] = []
  let out = join(OUT, 'candidates', 'ooxml-docx')
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only') {
      while (argv[i + 1] && !argv[i + 1]!.startsWith('--')) only.push(argv[++i]!)
    } else if (argv[i] === '--out') {
      out = argv[++i] ?? out
    }
  }
  return { only, out }
}

const { only, out } = parseArgs(process.argv.slice(2))
const corpus = JSON.parse(readFileSync(join(OUT, 'corpus.json'), 'utf8')) as {
  documents: CorpusDoc[]
}
const truthTop = JSON.parse(readFileSync(join(OUT, 'truth', 'manifest.json'), 'utf8')) as {
  documents: { id: string; status: string }[]
}
const docs = corpus.documents.filter(
  (d) =>
    d.format === 'docx' &&
    (only.length === 0 || only.includes(d.id)) &&
    truthTop.documents.some((t) => t.id === d.id && t.status === 'ok'),
)
const jobs = docs.map((d) => {
  const manifest = JSON.parse(readFileSync(join(OUT, 'truth', d.id, 'manifest.json'), 'utf8')) as {
    pages: TruthPage[]
  }
  return {
    id: d.id,
    pages: manifest.pages.map(({ n, file, width, height }) => ({ n, file, width, height })),
  }
})

const bundleDir = join(OUT, 'docx-page')
const built = await Bun.build({
  entrypoints: [join(import.meta.dir, 'docx-page.ts')],
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
<canvas id="page" style="display:block"></canvas><script type="module" src="/page.js"></script>`

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
  ['node', join(import.meta.dir, 'docx-shoot.mjs'), `http://127.0.0.1:${server.port}/`, out],
  { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' },
)
const code = await node.exited
server.stop(true)
process.exit(code)
