#!/usr/bin/env bun
/**
 * 将本地构建的安装包收集到 `.tmp/installer/`。
 *
 * Tauri 把产物写入 `.tmp/cargo-target/`，该目录存放构建中间产物，不是交付物。本地打包的
 * 输出位置统一为 `.tmp/installer/`，复制和校验成功后删除 bundle 目录中已收集的安装包。
 *
 * **本脚本只处理本地测试包。** 正式发布经由 `.github/workflows/release-windows.yml`：
 * 产物直接进入 GitHub 草稿 Release，不经过本脚本。
 *
 *   bun run scripts/collect-installer.ts
 */

import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const OUT_DIR = join(ROOT, '.tmp', 'installer')
const TAURI = join(ROOT, '.tmp', 'cargo-target')

/**
 * 带与不带 `--target` 时产物路径不同：CI 使用
 * `--target x86_64-pc-windows-msvc`，产物位于 `.tmp/cargo-target/<三元组>/release/…`；
 * 本地 `bun run tauri:build` 不带该参数，产物位于 `.tmp/cargo-target/release/…`。两处都查找。
 */
async function bundleDirs(targetDir: string): Promise<string[]> {
  const dirs = [join(targetDir, 'release/bundle/nsis')]
  const entries = await readdir(targetDir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (e.isDirectory() && e.name !== 'release' && e.name !== 'debug') {
      dirs.push(join(targetDir, e.name, 'release/bundle/nsis'))
    }
  }
  return dirs
}

/** 返回值即进程退出码：未找到安装包为 1，全部收集完成为 0。 */
export async function collect(targetDir: string, outDir: string): Promise<number> {
  const found: { dir: string; name: string }[] = []
  for (const dir of await bundleDirs(targetDir)) {
    for (const name of await readdir(dir).catch(() => [])) {
      if (name.endsWith('.exe') || name.endsWith('.exe.sig')) found.push({ dir, name })
    }
  }

  if (!found.some((file) => file.name.endsWith('.exe'))) {
    process.stderr.write('没有找到安装包，先跑 bun run tauri:build\n')
    return 1
  }

  await mkdir(outDir, { recursive: true })
  const delivered = new Set<string>()
  for (const f of found) {
    const dest = join(outDir, f.name)
    await copyFile(join(f.dir, f.name), dest)
    delivered.add(f.name)
    const size = (await Bun.file(dest).stat()).size
    process.stdout.write(`${dest}　${(size / 1024 / 1024).toFixed(1)} MB\n`)
  }

  for (const name of await readdir(outDir)) {
    if ((name.endsWith('.exe') || name.endsWith('.exe.sig')) && !delivered.has(name)) {
      await rm(join(outDir, name), { force: true })
    }
  }

  const sums: string[] = []
  for (const name of [...delivered].sort()) {
    const bytes = await readFile(join(outDir, name))
    sums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`)
  }
  await writeFile(join(outDir, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`, 'ascii')

  /*
   * 只删除已收集的安装包文件。
   *
   * **不要从 bundle 目录向上删除到 `release/`**：该层级下是 cargo 的全部编译产物
   * （deps、incremental、build），删除之后下一次 `tauri:build` 为冷编译，实测多耗时
   * 三分钟以上。交付物已复制，需要清理的只是留在原位置的副本。
   */
  for (const f of found) await rm(join(f.dir, f.name), { force: true })
  return 0
}

if (import.meta.main) process.exit(await collect(TAURI, OUT_DIR))
