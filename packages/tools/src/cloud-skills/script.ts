/**
 * 内置技能脚本的运行：`run_command` 收到 `<python> cloud-skill://<技能包>/scripts/<文件>.py 参数` 时，从云端取得脚本原文，
 * 命令中的脚本地址换为 `-`，原文经标准输入交给解释器。脚本不写成文件，模型无法读取原文（云端拒绝读取可运行的脚本）。
 *
 * 约束：一条命令只运行一个内置技能脚本，且解释器与脚本地址位于命令开头；其余写法（`cat`、管道中的第二个脚本）拒绝。
 * 脚本须是单个文件：经标准输入运行时没有 `__file__`，也不能引用同一技能中的其他文件。
 */

import type { ToolContext, ToolOutcome } from '@qywork/agent'
import { CLOUD_SKILL_SCHEME, cloudFailure, cloudTarget } from './source.ts'

/** 命令开头的解释器与脚本地址。 */
const SCRIPT_COMMAND = /^(\s*(?:python3?|py)(?:\.exe)?\s+)(cloud-skill:\/\/[^\s"'`;&|<>]+)/i

const USAGE =
  '内置技能的脚本只能以「python cloud-skill://<技能包>/scripts/<文件>.py 参数」运行，一条命令运行一个脚本，不能读取或复制'

/** 命令未执行的一句说明。 */
const refused = (message: string, errorKind: string): ToolOutcome => ({
  status: 'failure',
  executed: false,
  message,
  errorKind,
})

/** 运行内置技能脚本时实际执行的命令与经标准输入交给解释器的原文。 */
export interface BuiltinScript {
  command: string
  source: string
}

/**
 * 命令中没有内置技能地址时为 null；是内置技能脚本时取得原文并给出改写后的命令；其余写法与取得失败为一句说明。
 */
export async function builtinScript(
  ctx: Pick<ToolContext, 'port'>,
  command: string,
): Promise<BuiltinScript | ToolOutcome | null> {
  if (!command.includes(CLOUD_SKILL_SCHEME)) return null
  const m = SCRIPT_COMMAND.exec(command)
  if (!m || command.includes(CLOUD_SKILL_SCHEME, m[0].length)) {
    return refused(USAGE, 'bad_request')
  }
  const target = cloudTarget(ctx, m[2])
  if (!target) return refused('本轮无法运行内置技能的脚本：未连接云端', 'unavailable')
  if ('status' in target) return { ...target, executed: false }
  const got = await target.port.script(target.pkg, target.path)
  if (!got.ok) return { ...cloudFailure(got, target), executed: false }
  return {
    command: `${m[1]}-${command.slice(m[0].length)}`,
    source: launcher(target.path, got.value),
  }
}

/**
 * 经标准输入交给解释器的程序：把 `sys.argv[0]` 设为脚本的文件名后编译执行原文，帮助与报错中的程序名是文件名而不是 `-`。
 * 原文以 JSON 字符串字面量嵌入（也是合法的 Python 字符串字面量）；按文件名编译，磁盘上没有该文件，报错不显示源码行。
 */
function launcher(path: string, source: string): string {
  const name = JSON.stringify(path.split('/').pop() ?? path)
  return [
    'import sys',
    `sys.argv[0] = ${name}`,
    `exec(compile(${JSON.stringify(source)}, ${name}, 'exec'), {'__name__': '__main__', '__builtins__': __builtins__})`,
    '',
  ].join('\n')
}
