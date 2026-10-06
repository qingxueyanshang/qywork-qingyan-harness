#!/usr/bin/env bun
/**
 * 把 `VERSION` 中的版本号同步到所有声明了版本的文件。
 *
 * 版本号分布在多处：每个 package.json、Cargo.toml、Cargo.lock 中本仓库自身的包块、
 * tauri.conf.json，以及 sidecar 编译期内联读取的 VERSION 本身。发布时手动修改必然遗漏一处，
 * 而遗漏的通常是 tauri.conf.json：安装包版本与 `qy --version` 不一致，
 * 用户报告 bug 时给出的版本号是错误的。
 *
 *   bun run scripts/sync-version.ts          # 按 VERSION 同步
 *   bun run scripts/sync-version.ts 0.2.0    # 先修改 VERSION 再同步
 *   bun run scripts/sync-version.ts --check  # 只检查，不修改（CI 使用）
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
    process.stderr.write(`VERSION 中的内容不是合法版本号：${JSON.stringify(target)}\n`)
    return 2
  }

  const targets: { path: string; apply: (text: string) => string }[] = []

  if (explicit) targets.push({ path: versionFile, apply: () => `${target}\n` })

  // 三个 pattern 分别扫描，不写成大括号展开：Bun 的 Glob 不支持 `{a,b}`，
  // 写成大括号展开时不匹配任何文件且不报错，`--check` 因此始终返回「一致」。
  // 不可能失败的检查比没有检查更危险，因为它会被视为通过。
  const found: string[] = []
  for (const pattern of ['package.json', 'packages/*/package.json', 'apps/*/package.json']) {
    for await (const rel of new Glob(pattern).scan({ cwd: ROOT })) found.push(rel)
  }
  if (found.length === 0) {
    process.stderr.write('未扫描到任何 package.json，脚本很可能在错误的目录中运行\n')
    return 2
  }

  // package.json 只修改顶层第一个 "version"：依赖块中也可能出现该键，
  // 全局替换会把 "@tauri-apps/cli": "^2.11.4" 一并修改。
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
  // 只匹配 [package] 段中顶格的 version：依赖项的版本约束都带缩进或前缀。
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
   * 两个 Cargo.lock 中本仓库自身的 [[package]] 块。
   *
   * 清单已修改而 lock 未修改时，带 `--locked` 的检查、测试与构建全部以 101 失败
   * （`cannot update the lock file ... because --locked was passed`），而门禁中正包含这三条。
   * 必须锚定 `name = "<crate>"` 的下一行：依赖项的 version 行格式完全一样，
   * 不锚定时会修改其他包。
   */
  for (const [rel, crate] of [
    ['apps/desktop/src-tauri/Cargo.lock', 'qywork'],
    ['apps/desktop/native/computer-host/Cargo.lock', 'qy-computer-host'],
  ] as const) {
    const lockedCrate = new RegExp(`(name = "${crate}"\\nversion = )"[^"]*"`)
    targets.push({
      path: join(ROOT, rel),
      apply: (t) => {
        // 无法匹配时报错，不返回原文：原文会被判定为「已一致」，--check 因此始终通过。
        if (!lockedCrate.test(t)) throw new Error(`${rel} 中没有 ${crate} 的包块`)
        return t.replace(lockedCrate, `$1"${target}"`)
      },
    })
  }

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
  process.stdout.write(`\n已同步到 ${target}（修改了 ${stale} 个文件）\n`)
  return 0
}

process.exit(await main(Bun.argv.slice(2)))
