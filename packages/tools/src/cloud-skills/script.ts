/**
 * 内置技能脚本的运行：`run_command` 收到 `<python> cloud-skill://<技能包>/scripts/<文件>.py 参数` 时，从云端取得脚本原文，
 * 命令中的脚本地址换为 `-`，原文经标准输入交给解释器。脚本不写成文件，模型无法读取原文（云端拒绝读取可运行的脚本）。
 *
 * 约束：一条命令只运行一个内置技能脚本，且解释器与脚本地址位于命令开头；其余写法（`cat`、管道中的第二个脚本）拒绝。
 * 入口可以按模块名导入同一技能 `scripts/` 下的其他 Python 文件（云端随入口一并下发）。经标准输入运行时没有 `__file__`：
 * 脚本不能按路径读取技能中的文件，也不能以子进程运行同技能的其他脚本。
 */

import type { ToolContext, ToolOutcome } from '@qywork/agent'
import type { CloudSkillScript } from './port.ts'
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
    source: launcher(got.value),
  }
}

/**
 * 经标准输入交给解释器的程序：同目录的脚本由 `sys.meta_path` 中的查找器按模块名从内存加载，入口以 `__main__` 执行；
 * `sys.argv[0]` 设为入口的文件名，帮助与报错中的程序名是文件名而不是 `-`。
 * 原文以 JSON 字面量嵌入（也是合法的 Python 字面量）；按文件名编译，磁盘上没有该文件，报错不显示源码行。
 * 查找器插在 `sys.meta_path` 首位：当前目录中的同名文件不取代技能中的模块，与从磁盘运行时脚本目录排在 `sys.path` 首位的结果相同。
 */
function launcher(script: CloudSkillScript): string {
  const modules = Object.fromEntries(
    Object.entries(script.modules).map(([file, text]) => [file.replace(/\.py$/, ''), text]),
  )
  const main = JSON.stringify(script.main)
  return [
    'import sys, importlib.abc, importlib.util',
    `_SOURCES = ${JSON.stringify(modules)}`,
    'class _SkillModules(importlib.abc.MetaPathFinder, importlib.abc.Loader):',
    '    def find_spec(self, name, path=None, target=None):',
    '        return importlib.util.spec_from_loader(name, self) if path is None and name in _SOURCES else None',
    '    def create_module(self, spec):',
    '        return None',
    '    def exec_module(self, module):',
    "        exec(compile(_SOURCES[module.__name__], module.__name__ + '.py', 'exec'), module.__dict__)",
    'sys.meta_path.insert(0, _SkillModules())',
    `sys.argv[0] = ${main}`,
    `exec(compile(_SOURCES[${JSON.stringify(script.main.replace(/\.py$/, ''))}], ${main}, 'exec'), {'__name__': '__main__', '__builtins__': __builtins__})`,
    '',
  ].join('\n')
}
