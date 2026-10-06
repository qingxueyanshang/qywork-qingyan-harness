#!/usr/bin/env bun
/**
 * 将 `qy` 编译为单文件二进制，并按 Tauri 要求的命名放入 sidecar 目录
 * （`externalBin` 的命名规则见 `external-bin.ts`）。
 *
 *   bun run scripts/build-sidecar.ts
 */

import { mkdir, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
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
 * 六个字段必须同时传入：bun build 只覆盖显式传入的字段，遗漏的字段保留 Bun 的值。
 * 实测只传 `--windows-title` 时，CompanyName 仍是 Oven、LegalCopyright 仍指向 bun.com。
 *
 * `--windows-version` 只接受四段数字，而 VERSION 是 semver 且允许预发布后缀
 * （`scripts/sync-version.ts` 的 SEMVER）。必须先去除后缀再补第四段，
 * 否则 bun build 直接拒绝该参数。
 */
function windowsMetadata(version: string): string[] {
  if (process.platform !== 'win32') return []
  return [
    '--windows-title=qywork',
    '--windows-publisher=qywork',
    '--windows-description=qywork agent',
    `--windows-version=${version.split('-')[0]}.0`,
    '--windows-copyright=Apache-2.0',
    `--windows-icon=${ICON}`,
  ]
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

  // 使用当前进程的 Bun 可执行文件，不按 PATH 解析 `bun`：npm 安装的 Bun 在 PATH 上首先匹配 `bun.cmd`
  // 包装，Bun 1.4.2 拒绝把含引号的参数（下方的 `--define`）传给 .cmd，编译直接失败。
  const proc = Bun.spawn(
    [
      process.execPath,
      'build',
      ENTRY,
      '--compile',
      // minify 对启动速度没有帮助（单文件二进制中已是字节码），
      // 但能减小体积，而体积正是选择 Tauri 的理由之一。
      '--minify',
      '--sourcemap',
      '--define',
      `QYWORK_VERSION="${version}"`,
      ...windowsMetadata(version),
      '--outfile',
      outfile,
    ],
    { cwd: ROOT, stdout: 'inherit', stderr: 'inherit', stdin: 'ignore' },
  )
  const code = await proc.exited
  if (code !== 0) return code

  const size = (await Bun.file(outfile).stat()).size
  process.stdout.write(`完成：${(size / 1024 / 1024).toFixed(1)} MB\n`)

  // 编译后立即自检：编译产物无法运行时，到打包完成后才发现代价太大。
  const check = Bun.spawn([outfile, '--version'], { stdout: 'pipe', stderr: 'pipe' })
  const reported = (await new Response(check.stdout).text()).trim()
  if ((await check.exited) !== 0) {
    process.stderr.write('产物无法执行\n')
    return 1
  }
  if (reported !== version) {
    // 版本号不一致说明 --define 未生效，产物会在用户端报告错误的版本号，
    // 这是排查线上问题时误导性最强的一类信息。
    process.stderr.write(`版本号未内联：期望 ${version}，实得 ${reported}\n`)
    return 1
  }
  process.stdout.write(`自检通过：qy ${reported}\n`)
  return 0
}

process.exit(await main())
