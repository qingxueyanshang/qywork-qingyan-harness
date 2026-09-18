/**
 * Tauri `externalBin` 的产物命名与落点。
 *
 * `externalBin: ["bin/<名字>"]` 在打包时找的是 `bin/<名字>-<目标三元组>[.exe]`
 * （macOS 上还会因 arm64/x86_64 分成两个）。名字差一个字会等到打包末尾才报错，
 * 所以三元组由 `rustc -vV` 现问，而不是照着平台猜。
 *
 * 声明过的条目在编译期就必须存在：文件不在时 tauri 的构建脚本以 101 退出，
 * `cargo check` 与 `tauri dev` 同样会走到那一步。
 */

import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')

/** `externalBin` 里那个相对的 `bin/` 在磁盘上的位置。 */
export const BIN_DIR = join(ROOT, 'apps/desktop/src-tauri/bin')

/** 本机的 Rust 目标三元组。 */
export async function hostTriple(): Promise<string> {
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

/** `externalBin` 条目 `bin/<name>` 对应的本机产物路径。 */
export async function externalBinPath(name: string): Promise<string> {
  const ext = process.platform === 'win32' ? '.exe' : ''
  return join(BIN_DIR, `${name}-${await hostTriple()}${ext}`)
}
