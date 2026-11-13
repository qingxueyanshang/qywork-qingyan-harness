#!/usr/bin/env bun
/**
 * 构建 sidecar，产物分为两部分：
 *
 * - 运行时：原样复制的 Bun 可执行文件，按 Tauri `externalBin` 的命名放入 `bin/`（命名规则见 `external-bin.ts`）。
 * - 脚本目录 `bin/sidecar/`：入口 `index.js`、它的映射文件，以及按文件导入的资源（网页、wasm、库文件）。
 *
 * 启动方式为 `<运行时> <脚本目录>/index.js <参数>`。
 *
 * 不要改为 `compile` 产出单个可执行文件，也不要修改运行时的任何字节（含图标与版本信息）：
 * 运行时带有发行方的代码签名，内容变化后签名失效，无签名且尾部附带数据的可执行文件会被杀毒软件按启发式规则判为恶意。
 *
 *   bun run scripts/build-sidecar.ts
 */

import { copyFile, mkdir, readdir, rm } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import type { BunPlugin } from 'bun'
import { externalBinPath } from './external-bin.ts'

const ROOT = join(import.meta.dir, '..')
const ENTRY = join(ROOT, 'packages/cli/src/index.ts')

/**
 * 把图片库 photon 的 wasm 放入脚本目录。
 *
 * `photon_rs.js` 在求值时按 `__dirname` 读取 wasm，而打包器把 CJS 模块的 `__dirname` 内联为构建机的绝对路径；
 * 用户机器上没有该路径，缩略图、图片缩小与局部放大全部失败。改为 `require` wasm 文件本身后，
 * 它经由 `file` 加载器复制到脚本目录，导入值是相对脚本目录的路径，因此按入口脚本所在目录解析。
 * 未找到要替换的表达式时构建失败：photon 升级后改变了加载方式，需要重新核对。
 */
const embedPhotonWasm: BunPlugin = {
  name: 'embed-photon-wasm',
  setup(build) {
    build.onLoad({ filter: /[\\/]photon-node[\\/]photon_rs\.js$/ }, async ({ path }) => {
      const source = await Bun.file(path).text()
      const read = "require('path').join(__dirname, 'photon_rs_bg.wasm')"
      if (!source.includes(read)) throw new Error(`${path} 中未找到 wasm 的读取路径`)
      return {
        contents: source.replace(
          read,
          () =>
            "require('path').resolve(require('path').dirname(Bun.main), require('./photon_rs_bg.wasm'))",
        ),
        loader: 'js',
      }
    })
  },
}

/**
 * 网页构建产物的嵌入点。`qy serve` 未指定 `--static` 时提供嵌入的网页，供本机浏览器与远程访问打开。
 *
 * 网页在此处单独构建到临时目录，不读取 `apps/web/dist`：发布流程与门禁都在构建网页之前编译 sidecar
 * （`.github/actions/setup-build/action.yml` 的 Build sidecar 步骤），读取 `apps/web/dist` 得到的是缺失或过期的内容。
 */
const WEB_ASSETS_MODULE = /[\\/]packages[\\/]cli[\\/]src[\\/]web-assets\.ts$/

/** 构建网页到 `dir`，返回其中全部文件的绝对路径；失败或缺少 index.html 时返回 null。 */
async function buildWeb(dir: string): Promise<string[] | null> {
  const proc = Bun.spawn(
    [
      process.execPath,
      'run',
      '--cwd',
      join(ROOT, 'apps/web'),
      'build',
      '--outDir',
      dir,
      '--emptyOutDir',
    ],
    { cwd: ROOT, stdout: 'inherit', stderr: 'inherit', stdin: 'ignore' },
  )
  if ((await proc.exited) !== 0) {
    process.stderr.write('网页构建失败\n')
    return null
  }
  const files = (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
  if (!files.some((f) => relative(dir, f) === 'index.html')) {
    process.stderr.write(`网页构建产物中没有 index.html：${dir}\n`)
    return null
  }
  return files
}

/**
 * 把 `packages/cli/src/web-assets.ts` 的内容替换为逐个文件的 `type: 'file'` 导入，文件随之复制到脚本目录。
 * 导入值是相对脚本目录的路径，因此按 `import.meta.dir` 解析为绝对路径：sidecar 的工作目录不是脚本目录。
 * 未发生替换时（该模块改名或移动）构建须失败，由调用方按 `onEmbed` 是否被调用判定：否则产物不含网页且不报错。
 */
function embedWeb(dir: string, files: string[], onEmbed: () => void): BunPlugin {
  return {
    name: 'embed-web',
    setup(build) {
      build.onLoad({ filter: WEB_ASSETS_MODULE }, () => {
        onEmbed()
        const imports = files.map(
          (f, i) => `import f${i} from ${JSON.stringify(f)} with { type: 'file' }`,
        )
        const entries = files.map(
          (f, i) =>
            `${JSON.stringify(relative(dir, f).replaceAll('\\', '/'))}: resolve(import.meta.dir, f${i})`,
        )
        return {
          contents: `import { resolve } from 'node:path'\n${imports.join('\n')}\nexport const embeddedWeb = { ${entries.join(', ')} }\n`,
          loader: 'ts',
        }
      })
    },
  }
}

/**
 * 产物中出现仓库根路径时返回该处前后的内容，没有时返回 null。
 *
 * 构建机路径只在构建机上存在：依赖它读取文件的模块在构建机上照常运行，门禁无法发现，安装到其他机器后才失败。
 * 按原样、JSON 转义与正斜杠三种写法查找。
 */
function rootPathIn(bytes: Buffer): string | null {
  const forms = new Set([ROOT, ROOT.replaceAll('\\', '\\\\'), ROOT.replaceAll('\\', '/')])
  for (const form of forms) {
    const at = bytes.indexOf(form)
    if (at >= 0) {
      return bytes.subarray(Math.max(0, at - 60), at + form.length + 60).toString('latin1')
    }
  }
  return null
}

/**
 * `--outdir <目录>`（相对仓库根）：产物写入该目录而不是 `bin/`，文件名不变。
 * 门禁使用该参数：门禁只读，而开发实例运行期间 `bin/` 中的产物被占用、无法删除。
 */
function outdirArg(): string | null {
  const i = process.argv.indexOf('--outdir')
  return i >= 0 ? (process.argv[i + 1] ?? null) : null
}

/** 脚本目录相对运行时所在目录的名称。`tauri.conf.json` 的 `resources` 与外壳的启动参数使用同一名称。 */
const SCRIPT_DIR = 'sidecar'

async function main(): Promise<number> {
  const target = await externalBinPath('qy')
  const outdir = outdirArg()
  const runtime = outdir ? join(ROOT, outdir, basename(target)) : target
  const scriptDir = join(dirname(runtime), SCRIPT_DIR)
  const entry = join(scriptDir, 'index.js')

  // 脚本目录先清空：资源文件名带内容哈希，不清空时历次构建的文件都会进入安装包。
  await rm(scriptDir, { recursive: true, force: true })
  await mkdir(scriptDir, { recursive: true })
  await rm(runtime, { force: true })

  process.stdout.write(`构建 sidecar → ${scriptDir}\n`)

  // 版本号在构建期内联：安装目录中没有 VERSION 文件。
  const version = (await Bun.file(join(ROOT, 'VERSION')).text()).trim()

  const webDir = join(ROOT, '.tmp', 'build-sidecar', `web-${process.pid}`)
  const webFiles = await buildWeb(webDir)
  if (!webFiles) return 1
  let webEmbedded = false

  const result = await Bun.build({
    entrypoints: [ENTRY],
    outdir: scriptDir,
    target: 'bun',
    // 体积是选择 Tauri 的理由之一。
    minify: true,
    // 映射文件随脚本分发，运行时据此把报错堆栈还原为源码位置。
    sourcemap: 'linked',
    define: { QYWORK_VERSION: JSON.stringify(version) },
    // `embedPhotonWasm` 依赖 wasm 按文件复制；默认加载器改变时 photon 会读取到错误的内容。
    loader: { '.wasm': 'file' },
    plugins: [
      embedPhotonWasm,
      embedWeb(webDir, webFiles, () => {
        webEmbedded = true
      }),
    ],
    throw: false,
  }).finally(() => rm(webDir, { recursive: true, force: true }))
  if (!result.success) {
    for (const log of result.logs) process.stderr.write(`${log}\n`)
    return 1
  }
  if (!webEmbedded) {
    process.stderr.write('未找到 packages/cli/src/web-assets.ts，产物不含网页\n')
    return 1
  }

  if (!(await Bun.file(entry).exists())) {
    process.stderr.write(`构建产物中没有入口脚本：${entry}\n`)
    return 1
  }

  const bytes = Buffer.from(await Bun.file(entry).arrayBuffer())
  process.stdout.write(`完成：入口脚本 ${(bytes.length / 1024 / 1024).toFixed(1)} MB\n`)

  const leaked = rootPathIn(bytes)
  if (leaked) {
    process.stderr.write(`产物中含构建机路径，安装到其他机器后无法读取：\n${leaked}\n`)
    return 1
  }

  await copyFile(process.execPath, runtime)

  // 构建后立即自检：产物无法运行时，到打包完成后才发现代价太大。
  const check = Bun.spawn([runtime, entry, '--version'], { stdout: 'pipe', stderr: 'pipe' })
  const reported = (await new Response(check.stdout).text()).trim()
  if ((await check.exited) !== 0) {
    process.stderr.write('产物无法执行\n')
    return 1
  }
  if (reported !== version) {
    // 版本号不一致说明 `define` 未生效，产物会在用户端报告错误的版本号，
    // 这是排查线上问题时误导性最强的一类信息。
    process.stderr.write(`版本号未内联：期望 ${version}，实得 ${reported}\n`)
    return 1
  }
  process.stdout.write(`自检通过：qy ${reported}\n`)
  return 0
}

process.exit(await main())
