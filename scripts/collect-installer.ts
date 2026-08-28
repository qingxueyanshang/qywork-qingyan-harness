#!/usr/bin/env bun
/**
 * 把本地打出来的安装包收进 `.tmp/installer/`。
 *
 * Tauri 把产物写在 `.tmp/cargo-target/` 下，那是构建中间物、不是交付物。本地打包的
 * 落点统一是 `.tmp/installer/`，复制和校验成功后删除 release 中间物。
 *
 * **这条路只管本地测试包。** 正式发布走 `.github/workflows/release-windows.yml`：
 * 产物直接进 GitHub 草稿 Release，不经过这里。
 *
 *   bun run scripts/collect-installer.ts
 */

import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const OUT_DIR = join(ROOT, '.tmp', 'installer')
const TAURI = join(ROOT, '.tmp', 'cargo-target')

/**
 * 带 `--target` 与不带，产物路径不是同一条：CI 用
 * `--target x86_64-pc-windows-msvc`，落 `.tmp/cargo-target/<三元组>/release/…`；
 * 本地 `bun run tauri:build` 不带，落 `.tmp/cargo-target/release/…`。两条都找。
 */
async function bundleDirs(): Promise<string[]> {
  const dirs = [join(TAURI, 'release/bundle/nsis')]
  const entries = await readdir(TAURI, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (e.isDirectory() && e.name !== 'release' && e.name !== 'debug') {
      dirs.push(join(TAURI, e.name, 'release/bundle/nsis'))
    }
  }
  return dirs
}

async function main(): Promise<number> {
  const found: { dir: string; name: string }[] = []
  for (const dir of await bundleDirs()) {
    for (const name of await readdir(dir).catch(() => [])) {
      if (name.endsWith('.exe')) found.push({ dir, name })
    }
  }

  if (found.length === 0) {
    process.stderr.write('没有找到安装包，先跑 bun run tauri:build\n')
    return 1
  }

  await mkdir(OUT_DIR, { recursive: true })
  const delivered = new Set<string>()
  for (const f of found) {
    const dest = join(OUT_DIR, f.name)
    await copyFile(join(f.dir, f.name), dest)
    delivered.add(f.name)
    const size = (await Bun.file(dest).stat()).size
    process.stdout.write(`${dest}　${(size / 1024 / 1024).toFixed(1)} MB\n`)
  }

  for (const name of await readdir(OUT_DIR)) {
    if (name.endsWith('.exe') && !delivered.has(name)) {
      await rm(join(OUT_DIR, name), { force: true })
    }
  }

  const sums: string[] = []
  for (const name of [...delivered].sort()) {
    const bytes = await readFile(join(OUT_DIR, name))
    sums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`)
  }
  await writeFile(join(OUT_DIR, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`, 'ascii')

  const releases = new Set(found.map((f) => dirname(dirname(f.dir))))
  for (const release of releases) await rm(release, { recursive: true, force: true })
  return 0
}

process.exit(await main())
