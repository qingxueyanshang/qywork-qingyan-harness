#!/usr/bin/env bun
/**
 * 把 computer-host worker 编译成 release 二进制，并按 Tauri 要求的命名放进 sidecar 目录
 * （`externalBin` 的命名规则见 `external-bin.ts`）。
 *
 * worker 有自己的 Cargo manifest 与 lock，构建带 `--locked`：依赖版本与 lock 对不上时
 * 直接失败，不在构建过程里改写 lock。
 *
 *   bun run scripts/build-computer-host.ts
 */

import { copyFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { BIN_DIR, externalBinPath, hostTriple } from './external-bin.ts'

const ROOT = join(import.meta.dir, '..')
const MANIFEST = join(ROOT, 'apps/desktop/native/computer-host/Cargo.toml')
const NAME = 'qy-computer-host'

/**
 * 从 cargo 的 JSON 构建输出里取可执行产物的路径。
 *
 * 不要改成按约定拼 `<target-dir>/<三元组>/release/<名字>`：落点由
 * `.cargo/config.toml` 的 `build.target-dir` 决定，拼出来的那份是第二处声明，
 * 改了配置就会复制到一个过期的文件。
 */
function executablePath(stdout: string): string | null {
  let found: string | null = null
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue
    const msg = JSON.parse(line) as { reason?: string; executable?: string | null }
    if (msg.reason === 'compiler-artifact' && msg.executable) found = msg.executable
  }
  return found
}

async function main(): Promise<number> {
  const triple = await hostTriple()
  const outfile = await externalBinPath(NAME)

  process.stdout.write(`编译 ${NAME} → ${outfile}\n`)

  const proc = Bun.spawn(
    [
      'cargo',
      'build',
      '--release',
      '--locked',
      '--manifest-path',
      MANIFEST,
      '--target',
      triple,
      // 诊断仍按人读的格式走 stderr，stdout 只留产物清单。
      '--message-format',
      'json-render-diagnostics',
    ],
    { cwd: ROOT, stdout: 'pipe', stderr: 'inherit', stdin: 'ignore' },
  )
  const out = await new Response(proc.stdout).text()
  const code = await proc.exited
  if (code !== 0) return code

  const built = executablePath(out)
  if (built === null) {
    process.stderr.write('cargo 构建输出里没有可执行产物\n')
    return 1
  }

  await mkdir(BIN_DIR, { recursive: true })
  await rm(outfile, { force: true })
  await copyFile(built, outfile)

  const size = (await Bun.file(outfile).stat()).size
  process.stdout.write(`完成：${(size / 1024).toFixed(0)} KB\n`)
  return 0
}

process.exit(await main())
