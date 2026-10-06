/**
 * Tauri `externalBin` 的产物命名与存放位置。
 *
 * `externalBin: ["bin/<名称>"]` 打包时查找 `bin/<名称>-<目标三元组>[.exe]`
 * （macOS 上还会按 arm64/x86_64 分为两个）。名称相差一个字符时，到打包末尾才会报错，
 * 因此三元组由 `rustc -vV` 实时查询，而不是按平台推测。
 *
 * 已声明的条目在编译期必须存在：文件不存在时 tauri 的构建脚本以 101 退出，
 * `cargo check` 与 `tauri dev` 同样会执行该步骤。
 */

import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')

/** `externalBin` 中相对路径 `bin/` 在磁盘上的位置。 */
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
