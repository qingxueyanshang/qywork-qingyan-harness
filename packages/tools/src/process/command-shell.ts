/**
 * 执行命令的 shell：查找本机的 bash 与 PowerShell，给出 `run_command` 使用的 argv 与写给模型的语法说明。
 *
 * 本文件中的路径都位于本机文件系统，使用平台原生的 `joinNative`；沙箱参数的 POSIX 路径只在 `sandbox.ts` 中拼接。
 */

import { existsSync } from 'node:fs'
import { join as joinNative } from 'node:path'

/** 在 PATH 里查找一个可执行文件。未找到时返回 null。 */
export function whichSync(name: string): string | null {
  const paths = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
  for (const dir of paths) {
    if (!dir) continue
    const full = joinNative(dir, name)
    if (existsSync(full)) return full
  }
  return null
}

/**
 * Git for Windows 自带的 bash。未找到时返回 `null`。
 *
 * Windows 上只采用该 bash：`resolveBashPath` 的 win32 分支只调用它（由 `probeBash` 注入）。
 *
 * 不查 PATH。本机 `where bash` 的第一条结果是
 * `C:\Windows\System32\bash.exe`，即 WSL 启动器，它在另一个
 * 发行版的文件系统中运行命令（工作区在其中位于 `/mnt/c/...`），cwd 和路径全部不一致，
 * 且失败形式是「命令已执行但文件不存在」，比没有 bash 更难排查。
 * 因此只采用 Git 的安装目录，按几个确定的位置查找。
 *
 * 从 `git.exe` 反推时必须同时向上查找两级和三级：PATH 上可能是 `Git\cmd\git.exe`，
 * 也可能是 `Git\mingw64\bin\git.exe`（本机实测两者都存在）。
 */
function findGitBash(): string | null {
  const candidates: string[] = []
  const git = whichSync('git.exe')
  if (git) {
    const cmdDir = joinNative(git, '..')
    candidates.push(
      joinNative(cmdDir, '..', 'bin', 'bash.exe'),
      joinNative(cmdDir, '..', '..', 'bin', 'bash.exe'),
    )
  }
  const local = process.env.LOCALAPPDATA
  for (const base of [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    local ? joinNative(local, 'Programs') : undefined,
  ]) {
    if (base) candidates.push(joinNative(base, 'Git', 'bin', 'bash.exe'))
  }
  return candidates.find((p) => existsSync(p)) ?? null
}

/** 覆盖 bash 路径的环境变量。bash 安装在非常规位置（scoop、MSYS2、Cygwin）时只能经由它指定。 */
export const BASH_PATH_ENV = 'QYWORK_BASH_PATH'

/**
 * bash 的探测结果。结构与 `SandboxStatus` 相同：未找到是可上报的状态，不是异常。
 *
 * 易错点：不要在模块加载时抛出异常。否则在没有 bash 的机器上整个 `qy serve` 无法启动，
 * 用户在浏览器中只看到无法连接。终端程序可以 `exit(1)` 输出一行后退出，带界面的
 * 服务端不可以：它必须能启动，并如实报告本机没有 bash。
 *
 * 本类型只表示是否有 bash。没有 bash 时命令交给哪个 shell，
 * 由 `resolveCommandShell` 决定。
 */
export interface BashResolution {
  /** 找到的 bash 可执行文件；`null` 表示本机没有可用的 bash。 */
  path: string | null
  /** `path` 为 `null` 时说明原因与下一步操作；找到时为空串。 */
  reason: string
}

/** 执行命令的 shell。`null` 表示没有任何可用的 shell，此时 `run_command` 不会被注册。 */
export interface CommandShell {
  readonly path: string
  readonly argv: readonly string[]
  readonly hint: string
  /**
   * 命令写入脚本文件后的执行方式。提供此字段的 shell 在 Windows 上经脚本文件传递命令。
   *
   * 只有 bash 提供此字段。Windows 上 argv 需要经过一次命令行字符串的转换，而 MSYS
   * 按自身规则解析时会去掉成对反斜杠的一半：实测发送 1/2/3/4 个，到达
   * 1/1/2/2 个（`ceil(n/2)`）。结果是模型写的 `'\\'` 传给 python 时变为 `'\'`，
   * 产生 `SyntaxError`，且无从得知命令已被修改；正则的 `\\d`、Windows 路径同理。
   * 经脚本文件传递时，1/2/3/4 个反斜杠原样到达。
   *
   * 两种 PowerShell 不提供此字段，依据是实测结果：它们的 argv 不丢失反斜杠
   * （`-Command` 与 `-File` 都收到 4 个），而改用 `-File` 会丢失原生命令的非零
   * 退出码（`cmd /c exit 7` 时 `-Command` 返回 1、`-File` 返回 0），这比反斜杠问题更严重。
   */
  readonly scriptArgv?: (scriptPath: string) => readonly string[]
  /**
   * 执行命令前由 shell 读入的设置，参数为退出时写入管道各段退出码的文件，以及环境中原有的 `BASH_ENV`。
   * 只有 bash 提供（`bashPrelude`，经 `BASH_ENV` 读入）；两种 PowerShell 没有 pipefail 语义。
   */
  readonly prelude?: (statusFile: string, previous?: string) => string
}

/**
 * bash 执行命令前读入的设置（经 `BASH_ENV`）：开启 pipefail，退出时把最后一条管道各段的退出码写入 `statusFile`。
 *
 * 不开启 pipefail 时管道的退出码只取最后一段：`python crash.py | tail -3 && next` 报告成功并继续执行 next，
 * 前段的 KeyError 不出现在结果中（实测）。开启后前段失败即整条失败；前段被后段提前结束（`| head`）
 * 同样报告失败，区分这种情况需要各段的退出码，由 `shell.ts` 的 `pipelineExit` 判定。
 *
 * 经 `BASH_ENV` 读入，不拼接在命令正文之前：拼接的内容会出现在 bash 的语法错误回显中（`bash: -c: line 1: …`），
 * 另起一行则错误信息中的行号与模型所写的命令错开一行。读入后恢复环境中原有的 `BASH_ENV`（没有时删除），
 * 命令中再启动的 bash 与未加设置时相同。
 * 命令自行设置 EXIT trap 或以 exec 结束时不写入状态文件，退出码按 pipefail 的结果报告。
 */
function bashPrelude(statusFile: string, previous?: string): string {
  const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`
  const target = process.platform === 'win32' ? statusFile.replaceAll('\\', '/') : statusFile
  return [
    previous ? `export BASH_ENV=${quote(previous)}; . ${quote(previous)}` : 'unset BASH_ENV',
    'set -o pipefail',
    `__qy_pipestatus() { printf '%s' "\${PIPESTATUS[*]}" > ${quote(target)}; } 2>/dev/null`,
    'trap __qy_pipestatus EXIT',
    '',
  ].join('\n')
}

/**
 * 本机的 bash。未找到时返回 `null` 与原因，本函数不回退到其他 shell：
 * 回退到哪个 shell 由 `resolveCommandShell` 决定，只有那里能看到全部三种 shell。
 *
 * 必须提供环境变量入口。回退后的 PowerShell 语法与 bash 差异很大，因此 bash 安装在其他位置时，
 * 必须有一处用户可以自行指定的配置，否则 bash 安装在 scoop / MSYS2 / Cygwin / 自定义盘符的
 * 机器会被判定为没有 bash，从而使用本不需要的语法。
 *
 * 指定的路径不存在时返回 `null` 与原因，不静默回退到自动查找：回退会把路径配置错误变成
 * 「已运行，但运行的不是指定的 bash」，后者只能通过对比输出发现。
 *
 * 查找顺序：Windows 只采用 Git for Windows（不查 PATH 的原因见 `findGitBash`）。
 * 其余平台按位置查找，Homebrew 的 bash 5 排在 `/bin/bash` 之前：macOS 自带的
 * 是 bash 3.2（2007 年，停留在 GPLv2），没有 `declare -A`、`mapfile`、`${x,,}`，
 * 而模型按 bash 4+ 的语法编写。
 *
 * 不使用 `/bin/sh`：它在 Debian 系发行版上是 dash，`[[ ]]`、数组、`<(...)` 均不可用。
 * 判据是模型的默认语法必须与实际执行的 shell 一致；按同一判据，PowerShell
 * 只在未找到任何 bash 时才被采用，见 `resolveCommandShell`。
 *
 * 参数全部注入，以便直接测试查找顺序与环境变量覆盖，无需重新加载模块。
 */
export function resolveBashPath(deps: {
  env: Record<string, string | undefined>
  platform: string
  exists: (p: string) => boolean
  gitBash: () => string | null
}): BashResolution {
  const pinned = deps.env[BASH_PATH_ENV]
  if (pinned) {
    if (deps.exists(pinned)) return { path: pinned, reason: '' }
    return {
      path: null,
      reason: `${BASH_PATH_ENV} 指向 ${pinned}，但该位置不存在文件。修正该值，或不设置该变量以启用自动查找。`,
    }
  }

  if (deps.platform === 'win32') {
    const bash = deps.gitBash()
    if (bash !== null) return { path: bash, reason: '' }
    return {
      path: null,
      reason:
        '未找到 Git for Windows 自带的 bash（已查找 git.exe 的同级目录、' +
        `Program Files\\Git\\bin、LOCALAPPDATA\\Programs\\Git\\bin）。安装 Git for Windows，或用 ${BASH_PATH_ENV} 指向已有的 bash.exe。`,
    }
  }

  const candidates = ['/opt/homebrew/bin/bash', '/usr/local/bin/bash', '/bin/bash', '/usr/bin/bash']
  const found = candidates.find(deps.exists)
  if (found !== undefined) return { path: found, reason: '' }
  return {
    path: null,
    reason: `以下位置均未找到 bash：${candidates.join('、')}。安装 bash，或用 ${BASH_PATH_ENV} 指向 bash。`,
  }
}

/**
 * 探测本机的 bash。每次调用重新探测，不缓存。
 *
 * 缓存时，安装 git 后重新连接不会生效，
 * 用户必须重启整个服务，且无从得知需要重启。探测只是几次 `existsSync`
 * （`whichSync` 只扫描 PATH，不启动进程），每次执行的开销可以接受。
 */
export function probeBash(): BashResolution {
  return resolveBashPath({
    env: process.env,
    platform: process.platform,
    exists: existsSync,
    gitBash: findGitBash,
  })
}

/**
 * 三种 shell 探测的注入参数。
 *
 * 参数全部注入，理由同 `resolveBashPath`：本机只会命中其中一种
 * （安装了 Git Bash 的机器在第一步即返回），查找顺序与另外两种的结果只能以注入方式测试。
 */
export interface ShellProbeDeps {
  bash: () => BashResolution
  /** 在 PATH 上查找可执行文件。 */
  which: (name: string) => string | null
  exists: (p: string) => boolean
  env: Record<string, string | undefined>
}

/** PowerShell 7 的默认安装位置。安装在其他位置时经由 PATH 上的 `pwsh.exe` 查找。 */
function pwsh7Install(env: Record<string, string | undefined>): string {
  return joinNative(env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')
}

/**
 * Windows PowerShell 5.1 的固定位置。系统盘不一定是 C:，因此按 `SystemRoot` 确定；
 * 它是系统组件，不查 PATH：PATH 上名为 `powershell` 的可能是其他同名程序。
 */
function windowsPowerShellInstall(env: Record<string, string | undefined>): string {
  return joinNative(
    env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
}

/**
 * 选择执行命令的 shell，并给出模型必须知道的语法差异。
 *
 * 顺序：bash → pwsh 7 → Windows PowerShell 5.1 → 无可用 shell。
 *
 * bash 始终排第一。模型的默认语法是 POSIX：训练数据中运行命令的语境
 * 绝大多数是 bash；账本中有过只被告知「平台：win32」就按 POSIX 写法编写、
 * 在 PowerShell 上完全未执行的调用（`node --version & python --version`）。
 * 有 bash 的机器上始终使用 bash。
 *
 * pwsh 7 优先于 5.1 是硬性差异，不是偏好。5.1 上 `&&` / `||` 是解析错误
 * （实测 `标记「&&」不是此版本中的有效语句分隔符`），也不支持三元 `? :`、`??`、`?.`、
 * `ConvertFrom-Json -AsHashtable`：同一条命令在 7 上执行成功，在 5.1 上
 * 整条失败。两者都存在时必须选择 7。
 *
 * 两种 PowerShell 都必须使用 `-NoProfile`：用户 profile 会改变行为（别名、函数、`$ErrorActionPreference`），
 * 而其内容在其他机器上无法预知。
 *
 * 语法差异带来三处成本：
 *
 * `policy.ts` 的拒绝规则必须同时识别两种语法、涉及命令的测试必须按 shell 区分、
 * 模型收到的提示也随之不同。前两处是固定成本，无法避免。第三处通过将语法提示前置缓解：
 * `hint` 是 `run_command` 描述的第一句，非 bash 时第一句即声明「不是 bash」。
 * 缓解不等于消除：`run_command` 这个名称本身不携带语法信息，而名称的影响强于描述。
 *
 * 收益是：未安装 Git Bash 的 Windows 机器上，agent 从无法运行任何命令变为可以运行。
 *
 * `hint` 原样写入 `run_command` 的工具说明，与 `spawnGuarded` 使用的 argv 来自同一对象：
 * 两处分别编写必然不一致，告知模型的 shell 与实际执行的 shell 不同，
 * 比不告知更糟。
 *
 * 三种 shell 均未找到时返回 `null`，`run_command` 不会被注册（`tools/index.ts`）：
 * 模型没有该工具，而不是持有一个必然失败的工具。
 */
export function resolveCommandShell(deps: ShellProbeDeps): CommandShell | null {
  const bash = deps.bash().path
  if (bash !== null) {
    return {
      path: bash,
      argv: [bash, '-c'],
      // 以正斜杠形式把路径交给 MSYS：反斜杠形式的路径同样会经过上述去除反斜杠的解析。
      scriptArgv: (scriptPath) => [bash, scriptPath.replaceAll('\\', '/')],
      prelude: bashPrelude,
      hint:
        '命令由 `bash -c` 执行（POSIX 语法；Windows 上是 Git for Windows 自带的 bash，' +
        '不是 cmd/PowerShell，也不是 WSL）：`&&`、`||`、管道、`2>/dev/null` 都可用；路径用 `/` 分隔。' +
        '已开启 pipefail：管道中任一段失败即整条失败。',
    }
  }

  // pwsh 7 可安装在任意位置，因此优先查 PATH；已安装但未加入 PATH 时由默认安装位置查找。
  const installed = pwsh7Install(deps.env)
  const pwsh7 = deps.which('pwsh.exe') ?? (deps.exists(installed) ? installed : null)
  if (pwsh7 !== null) {
    return {
      path: pwsh7,
      argv: [pwsh7, '-NoProfile', '-NonInteractive', '-Command'],
      hint:
        '**本机没有 bash：命令由 PowerShell 7（`pwsh -NoProfile -NonInteractive -Command`）' +
        '执行，不是 bash。** 按 PowerShell 语法编写：`&&`、`||`、管道可用，但管道中传递的是对象而非文本；' +
        '`2>/dev/null` 写作 `2>$null`；环境变量写作 `$env:NAME`；`ls`/`cat`/`rm` 是 cmdlet 的别名，' +
        '参数写法与 POSIX 不同（`ls -Recurse`、`rm -Recurse -Force`）。',
    }
  }

  const ps51 = windowsPowerShellInstall(deps.env)
  if (deps.exists(ps51)) {
    return {
      path: ps51,
      argv: [ps51, '-NoProfile', '-NonInteractive', '-Command'],
      hint:
        '**本机既没有 bash 也没有 PowerShell 7：命令由 Windows PowerShell 5.1' +
        '（`powershell -NoProfile -NonInteractive -Command`）执行，不是 bash。** ' +
        '5.1 不支持以下写法，按 PowerShell 7 的写法编写会导致整条命令失败：' +
        '`&&` / `||`（解析错误；顺序执行用 `;`，仅在上一条成功时继续用 `if ($?) { … }`）、' +
        '三元 `? :`、null 合并 `??`、null 条件 `?.`、`ConvertFrom-Json -AsHashtable`。' +
        '其余按 PowerShell 语法编写：`2>$null`、`$env:NAME`、`ls -Recurse`。',
    }
  }

  return null
}

/**
 * 本机的 shell。每次调用重新探测，理由同 `probeBash`：安装完成后，
 * 下一条消息即应可用 `run_command`，无需用户重启服务。
 */
export function commandShell(): CommandShell | null {
  return resolveCommandShell({
    bash: probeBash,
    which: whichSync,
    exists: existsSync,
    env: process.env,
  })
}
