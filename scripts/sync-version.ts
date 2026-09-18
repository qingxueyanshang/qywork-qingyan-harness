#!/usr/bin/env bun
/**
 * 把 `VERSION` 里的版本号刷到所有声明了版本的文件里。
 *
 * 版本号散落在多处：每个 package.json、Cargo.toml、Cargo.lock 里本仓自己的包块、
 * tauri.conf.json，外加 sidecar 编译期内联读的 VERSION 本身。发版时手改必漏一个，
 * 而漏掉的那个通常是 tauri.conf.json——安装包版本和 `qy --version` 对不上，
 * 用户报 bug 时说的版本号是错的。
 *
 *   bun run scripts/sync-version.ts          # 按 VERSION 刷
 *   bun run scripts/sync-version.ts 0.2.0    # 先改 VERSION 再刷
 *   bun run scripts/sync-version.ts --check  # 只检查，不改（CI 用）
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Glob } from 'bun'

const ROOT = join(import.meta.dir, '..')
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

async function main(argv: string[]): Promise<number> {
  const check = argv.includes('--check')
  const explicit = argv.find((a) => !a.startsWith('--'))

  if (explicit && !SEMVER.test(explicit)) {
    process.stderr.write(`不是合法的版本号：${explicit}\n`)
    return 2
  }

  const versionFile = join(ROOT, 'VERSION')
  const current = (await readFile(versionFile, 'utf8')).trim()
  const target = explicit ?? current

  if (!SEMVER.test(target)) {
    process.stderr.write(`VERSION 里的内容不是合法版本号：${JSON.stringify(target)}\n`)
    return 2
  }

  const targets: { path: string; apply: (text: string) => string }[] = []

  if (explicit) targets.push({ path: versionFile, apply: () => `${target}\n` })

  // 三个 pattern 分开扫，不写成一个大括号展开：Bun 的 Glob 不支持 `{a,b}`，
  // 写成那样会**一个文件都匹配不到而且不报错**——`--check` 因此永远返回「一致」。
  // 一个不可能失败的检查比没有检查更危险，因为它会被当成通过。
  const found: string[] = []
  for (const pattern of ['package.json', 'packages/*/package.json', 'apps/*/package.json']) {
    for await (const rel of new Glob(pattern).scan({ cwd: ROOT })) found.push(rel)
  }
  if (found.length === 0) {
    process.stderr.write('一个 package.json 都没扫到，脚本大概率跑错了目录\n')
    return 2
  }

  // package.json 只改**顶层第一个** "version"：依赖块里也可能出现这个键，
  // 全局替换会把 "@tauri-apps/cli": "^2.11.4" 一起改掉。
  for (const rel of found) {
    targets.push({
      path: join(ROOT, rel),
      apply: (t) => t.replace(/^(\s*"version"\s*:\s*)"[^"]*"/m, `$1"${target}"`),
    })
  }

  targets.push({
    path: join(ROOT, 'apps/desktop/src-tauri/tauri.conf.json'),
    apply: (t) => t.replace(/^(\s*"version"\s*:\s*)"[^"]*"/m, `$1"${target}"`),
  })
  // 只认 [package] 段里那个顶格的 version：依赖项的版本约束都带缩进或前缀。
  for (const rel of [
    'apps/desktop/src-tauri/Cargo.toml',
    'apps/desktop/native/computer-host/Cargo.toml',
  ]) {
    targets.push({
      path: join(ROOT, rel),
      apply: (t) => t.replace(/^version\s*=\s*"[^"]*"/m, `version = "${target}"`),
    })
  }

  /*
   * computer-host 的 Cargo.lock 里本 crate 自己那个 [[package]] 块。
   *
   * 清单改了而 lock 没改，带 `--locked` 的检查、测试与构建全部以 101 失败
   * （`cannot update the lock file ... because --locked was passed`），而门禁里正有这三条。
   * 必须锚定 `name = "qy-computer-host"` 的下一行：依赖项的 version 行格式完全一样，
   * 不锚定就会改到别的包。
   */
  const lockedCrate = /(name = "qy-computer-host"\nversion = )"[^"]*"/
  targets.push({
    path: join(ROOT, 'apps/desktop/native/computer-host/Cargo.lock'),
    apply: (t) => {
      // 匹配不上就报错，不返回原文：原文会被判成「已一致」，--check 因此永远通过。
      if (!lockedCrate.test(t)) throw new Error('Cargo.lock 里没有 qy-computer-host 的包块')
      return t.replace(lockedCrate, `$1"${target}"`)
    },
  })

  let stale = 0
  for (const t of targets) {
    const before = await readFile(t.path, 'utf8').catch(() => null)
    if (before === null) {
      process.stderr.write(`跳过（不存在）：${t.path}\n`)
      continue
    }
    const after = t.apply(before)
    if (after === before) continue
    stale++
    if (check) {
      process.stdout.write(`  ✗ ${t.path.slice(ROOT.length + 1)}\n`)
    } else {
      await writeFile(t.path, after, 'utf8')
      process.stdout.write(`  ✓ ${t.path.slice(ROOT.length + 1)}\n`)
    }
  }

  if (check) {
    process.stdout.write(
      stale === 0 ? `版本号一致：${target}\n` : `\n${stale} 个文件与 VERSION（${target}）不一致\n`,
    )
    return stale === 0 ? 0 : 1
  }
  process.stdout.write(`\n已同步到 ${target}（改了 ${stale} 个文件）\n`)
  return 0
}

process.exit(await main(Bun.argv.slice(2)))
