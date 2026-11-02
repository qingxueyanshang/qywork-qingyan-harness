/**
 * xlsx 候选截图：按真值清单的工作表与区域，用 `@qywork/ooxml` 绘制并截图，输出到候选目录供 `fidelity.py score` 打分。
 *
 *   bun run scripts/ooxml-fidelity/xlsx-candidates.ts [--only <文档标识>…] [--out <目录>]
 *
 * 分工：本脚本（Bun）打包浏览器入口 `xlsx-page.ts`，并以本地 HTTP 服务提供页面、xlsx 字节与本机字体；
 * `xlsx-shoot.mjs`（Node）驱动 Playwright 打开 Edge，设备像素比 1，逐页调用 `renderPage` 并对画布截图。
 * Playwright 只能由 Node 驱动：Bun 对 `--remote-debugging-pipe` 的管道支持不完整，启动浏览器时阻塞。
 *
 * 输出：`<out>/<文档标识>/page-0001.png` 起，文件名与真值清单一致。缺省输出目录为
 * `.tmp/ooxml-fidelity/candidates/ooxml`。语料与真值见 `fidelity.py` 的文件头。
 * 单元格文字按真值清单记录的采集时系统字体平滑设置（`font_smoothing`）绘制，与界面按主机设置绘制的规则相同
 * （`fontSmoothing`）；清单没有该记录时停止。
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractFace } from '../../packages/ooxml/src/font/index.ts'
import { fontSmoothing, type SmoothingParameters } from '../../packages/server/src/api/fonts.ts'
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
  readonly sheet: string
  readonly range: string
  readonly width: number
  readonly height: number
}

function parseArgs(argv: string[]): { only: string[]; out: string } {
  const only: string[] = []
  let out = join(OUT, 'candidates', 'ooxml')
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
    d.format === 'xlsx' &&
    (only.length === 0 || only.includes(d.id)) &&
    truthTop.documents.some((t) => t.id === d.id && t.status === 'ok'),
)
const jobs = docs.map((d) => {
  const manifest = JSON.parse(readFileSync(join(OUT, 'truth', d.id, 'manifest.json'), 'utf8')) as {
    font_smoothing?: SmoothingParameters
    pages: TruthPage[]
  }
  if (!manifest.font_smoothing) {
    console.error(`真值清单没有记录字体平滑设置：${d.id}`)
    process.exit(1)
  }
  return {
    id: d.id,
    clearType: fontSmoothing(manifest.font_smoothing).clearType,
    pages: manifest.pages.map(({ file, sheet, range, width, height }) => ({
      file,
      sheet,
      range,
      width,
      height,
    })),
  }
})

const bundleDir = join(OUT, 'xlsx-page')
const built = await Bun.build({
  entrypoints: [join(import.meta.dir, 'xlsx-page.ts')],
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
<canvas id="sheet" style="display:block"></canvas><script type="module" src="/page.js"></script>`

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
  ['node', join(import.meta.dir, 'xlsx-shoot.mjs'), `http://127.0.0.1:${server.port}/`, out],
  {
    cwd: ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
  },
)
const code = await node.exited
server.stop(true)
process.exit(code)
