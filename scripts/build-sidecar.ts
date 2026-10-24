#!/usr/bin/env bun
/**
 * 将 `qy` 编译为单文件二进制，并按 Tauri 要求的命名放入 sidecar 目录
 * （`externalBin` 的命名规则见 `external-bin.ts`）。
 *
 *   bun run scripts/build-sidecar.ts
 */

import { mkdir, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { BunPlugin, CompileBuildOptions } from 'bun'
import { BIN_DIR, externalBinPath } from './external-bin.ts'

const ROOT = join(import.meta.dir, '..')
const ENTRY = join(ROOT, 'packages/cli/src/index.ts')
const ICON = join(ROOT, 'apps/desktop/src-tauri/icons/icon.ico')

/**
 * Windows PE 版本信息。仅在编译目标为 Windows 时传入。
 *
 * 不传入任何字段时，产物保留 Bun 运行时自身的资源段：ProductName=Bun、
 * CompanyName=Oven、OriginalFilename=bun.exe。文件属性、任务管理器和杀毒软件
 * 因此把 sidecar 标识为 Bun。补齐这些字段只修正文件归属，不是代码签名，
 * 不建立任何系统信任。
 *
 * 六个字段必须同时传入：Bun 只覆盖显式传入的字段，遗漏的字段保留 Bun 的值。
 * 实测只传 `title` 时，CompanyName 仍是 Oven、LegalCopyright 仍指向 bun.com。
 *
 * `version` 只接受四段数字，而 VERSION 是 semver 且允许预发布后缀
 * （`scripts/sync-version.ts` 的 SEMVER）。必须先去除后缀再补第四段，
 * 否则编译直接拒绝该字段。
 */
function windowsMetadata(version: string): Pick<CompileBuildOptions, 'windows'> {
  if (process.platform !== 'win32') return {}
  return {
    windows: {
      title: 'qywork',
      publisher: 'qywork',
      description: 'qywork agent',
      version: `${version.split('-')[0]}.0`,
      copyright: 'Apache-2.0',
      icon: ICON,
    },
  }
}

/**
 * 把图片库 photon 的 wasm 嵌入产物。
 *
 * `photon_rs.js` 在求值时按 `__dirname` 读取 wasm，而打包器把 CJS 模块的 `__dirname` 内联为构建机的绝对路径；
 * 用户机器上没有该路径，缩略图、图片缩小与局部放大全部失败。改为 `require` wasm 文件本身后，
 * 它经由 `file` 加载器嵌入产物，运行时得到产物内的路径。未找到要替换的表达式时构建失败：
 * photon 升级后改变了加载方式，需要重新核对。
 */
const embedPhotonWasm: BunPlugin = {
  name: 'embed-photon-wasm',
  setup(build) {
    build.onLoad({ filter: /[\\/]photon-node[\\/]photon_rs\.js$/ }, async ({ path }) => {
      const source = await Bun.file(path).text()
      const read = "require('path').join(__dirname, 'photon_rs_bg.wasm')"
      if (!source.includes(read)) throw new Error(`${path} 中未找到 wasm 的读取路径`)
      return {
        contents: source.replace(read, () => "require('./photon_rs_bg.wasm')"),
        loader: 'js',
      }
    })
  },
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

async function main(): Promise<number> {
  const target = await externalBinPath('qy')
  const outdir = outdirArg()
  const outfile = outdir ? join(ROOT, outdir, basename(target)) : target

  await mkdir(outdir ? dirname(outfile) : BIN_DIR, { recursive: true })
  await rm(outfile, { force: true })

  process.stdout.write(`编译 sidecar → ${outfile}\n`)

  // 版本号在编译期内联。运行时在单文件二进制中读取 VERSION 文件必然失败：
  // 相对路径无法解析到打包之外的文件，实测输出会变为后备值 0.0.0。
  const version = (await Bun.file(join(ROOT, 'VERSION')).text()).trim()

  const result = await Bun.build({
    entrypoints: [ENTRY],
    compile: { outfile, ...windowsMetadata(version) },
    // minify 对启动速度没有帮助（单文件二进制中已是字节码），
    // 但能减小体积，而体积正是选择 Tauri 的理由之一。
    minify: true,
    sourcemap: 'linked',
    define: { QYWORK_VERSION: JSON.stringify(version) },
    // `embedPhotonWasm` 依赖 wasm 按文件嵌入；默认加载器改变时 photon 会读取到错误的内容。
    loader: { '.wasm': 'file' },
    plugins: [embedPhotonWasm],
    throw: false,
  })
  if (!result.success) {
    for (const log of result.logs) process.stderr.write(`${log}\n`)
    return 1
  }

  const bytes = Buffer.from(await Bun.file(outfile).arrayBuffer())
  process.stdout.write(`完成：${(bytes.length / 1024 / 1024).toFixed(1)} MB\n`)

  const leaked = rootPathIn(bytes)
  if (leaked) {
    process.stderr.write(`产物中含构建机路径，安装到其他机器后无法读取：\n${leaked}\n`)
    return 1
  }

  // 编译后立即自检：编译产物无法运行时，到打包完成后才发现代价太大。
  const check = Bun.spawn([outfile, '--version'], { stdout: 'pipe', stderr: 'pipe' })
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
