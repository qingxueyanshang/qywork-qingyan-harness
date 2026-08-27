#!/usr/bin/env bun
/**
 * 把本地打出来的安装包收进 `.tmp/installer/`。
 *
 * Tauri 把产物写在 cargo 的 `target/` 下，那是构建中间物、不是交付物：换个人打包
 * 就把 exe 留在那里，谁也不知道该去哪个 `release/bundle/nsis` 找。本地打包测试的
 * 落点统一是 `.tmp/installer/`（B6），由 `scripts/temp-dir.test.ts` 在门禁里盯着。
 *
 * **这条路只管本地测试包。** 正式发布走 `.github/workflows/release-windows.yml`：
 * 产物直接进 GitHub 草稿 Release，不经过这里。
 *
 *   bun run scripts/collect-installer.ts
 */

import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const OUT_DIR = join(ROOT, '.tmp', 'installer')
const TAURI = join(ROOT, 'apps/desktop/src-tauri/target')

/**
 * 带 `--target` 与不带，产物路径不是同一条：CI 用
 * `--target x86_64-pc-windows-msvc`，落 `target/<三元组>/release/…`；
 * 本地 `bun run tauri:build` 不带，落 `target/release/…`。两条都找。
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
  for (const f of found) {
    const dest = join(OUT_DIR, f.name)
    await copyFile(join(f.dir, f.name), dest)
    const size = (await Bun.file(dest).stat()).size
    process.stdout.write(`${dest}　${(size / 1024 / 1024).toFixed(1)} MB\n`)
  }
  return 0
}

process.exit(await main())
