/**
 * 全局数据目录：`~/.qywork`，设置 `QYWORK_HOME` 时为该目录。配置文件（明文 apiKey）、全局 MCP 配置、
 * 会话账本（含权限模式）、全局记忆、技能与插件都位于其中。
 *
 * 只依赖 node 内置模块：本目录的 `place.ts` 由测试预载 `scripts/rm-guard.ts` 直接导入，不经过包入口。
 */

import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * 全局数据目录的路径。每次调用都读取环境变量：测试按进程与用例修改 `QYWORK_HOME`。
 *
 * 此处是唯一的定义：tools 的三层作用域、runtime 的 `configDir()`、凭证文件的判定（`credentials.ts`）与
 * 位置判定（`place.ts`）都调用本函数。各处分别计算时，修改 `QYWORK_HOME` 之后配置与全局记忆位于两个目录，
 * 凭证与位置判定保护的也不再是实际使用的目录。
 */
export function globalScopeRoot(): string {
  return process.env.QYWORK_HOME ?? join(homedir(), '.qywork')
}

/**
 * 一个目录的绝对路径与真实路径（展开符号链接与目录联接），两者相同时只有一项；无法解析时只有绝对路径。
 * 相对路径以进程的当前目录为基准，与读取 `QYWORK_HOME` 的各处相同。
 *
 * 命令中的路径是字面写法，文件工具判定的是真实路径。按目录判定的规则须同时比较两种形式：只比较一种时，
 * 经链接指向别处的目录以另一种写法给出即不被识别，两侧对同一位置的结论不同。
 */
export function pathForms(dir: string): string[] {
  if (dir === '') return []
  const abs = resolve(dir)
  let real: string
  try {
    real = realpathSync(abs)
  } catch {
    return [abs]
  }
  return real === abs ? [abs] : [abs, real]
}
