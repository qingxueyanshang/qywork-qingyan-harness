#!/usr/bin/env bun
/**
 * 把 `qy` 编译成单文件二进制，并按 Tauri 要求的命名放进 sidecar 目录。
 *
 * Tauri 的 `externalBin: ["bin/qy"]` 在打包时会去找 `bin/qy-<目标三元组>`
 * （macOS 上还会因 arm64/x86_64 分成两个）。名字差一个字都会在打包末尾才报错，
 * 所以三元组由 `rustc -vV` 现问，而不是照着平台猜。
 *
 *   bun run scripts/build-sidecar.ts
 */

import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const OUT_DIR = join(ROOT, 'apps/desktop/src-tauri/bin')
const ENTRY = join(ROOT, 'packages/cli/src/index.ts')
const ICON = join(ROOT, 'apps/desktop/src-tauri/icons/icon.ico')

async function hostTriple(): Promise<string> {
  const proc = Bun.spawn(['rustc', '-vV'], { stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(proc.stdout).text()
  const code = await proc.exited
  if (code !== 0) {
    throw new Error('未找到 rustc。Tauri 需要 Rust 工具链，请先安装：https://rustup.rs')
  }
  const m = /^host:\s*(\S+)$/m.exec(out)
  if (!m) throw new Error('无法从 rustc -vV 解析目标三元组')
  return m[1]!
}

/**
 * Windows PE 版本信息。仅在编译目标为 Windows 时传。
 *
 * 一个字段都不传的产物会原样带着 Bun 运行时自己的资源段：ProductName=Bun、
 * CompanyName=Oven、OriginalFilename=bun.exe。文件属性、任务管理器和杀毒软件
 * 因此把 sidecar 标成 Bun。补齐这些字段只修正文件归属，它不是代码签名，
 * 不建立任何系统信任。
 *
 * 六个字段必须一起给：bun build 只覆盖显式传入的字段，漏掉的保留 Bun 的值。
 * 实测只传 `--windows-title` 时，CompanyName 仍是 Oven、LegalCopyright 仍指向 bun.com。
 *
 * `--windows-version` 只收四段数字，而 VERSION 是 semver 且允许预发布后缀
 * （`scripts/sync-version.ts` 的 SEMVER）。必须先截掉后缀再补第四段，
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

async function main(): Promise<number> {
  const triple = await hostTriple()
  const ext = process.platform === 'win32' ? '.exe' : ''
  const outfile = join(OUT_DIR, `qy-${triple}${ext}`)

  await mkdir(OUT_DIR, { recursive: true })
  await rm(outfile, { force: true })

  process.stdout.write(`编译 sidecar → ${outfile}\n`)

  // 版本号在编译期内联。运行时读 VERSION 文件在单文件二进制里必然失败——
  // 相对路径解析不到打包外的文件，实测输出会变成兜底的 0.0.0。
  const version = (await Bun.file(join(ROOT, 'VERSION')).text()).trim()

  const proc = Bun.spawn(
    [
      'bun',
      'build',
      ENTRY,
      '--compile',
      // minify 对启动速度没有帮助（单文件二进制里已是字节码），
      // 但能减小体积，而体积正是选 Tauri 的理由之一。
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

  // 立刻自检一次：编译产物跑不起来的话，等到打包完再发现代价太大。
  const check = Bun.spawn([outfile, '--version'], { stdout: 'pipe', stderr: 'pipe' })
  const reported = (await new Response(check.stdout).text()).trim()
  if ((await check.exited) !== 0) {
    process.stderr.write('产物无法执行\n')
    return 1
  }
  if (reported !== version) {
    // 版本号对不上说明 --define 没生效，产物会在用户那里报一个假版本，
    // 排查线上问题时这是最误导人的一类信息。
    process.stderr.write(`版本号未内联：期望 ${version}，实得 ${reported}\n`)
    return 1
  }
  process.stdout.write(`自检通过：qy ${reported}\n`)
  return 0
}

process.exit(await main())
