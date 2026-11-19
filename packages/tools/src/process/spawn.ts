/**
 * 启动子进程的唯一入口，以及包裹它的操作系统沙箱。
 *
 * 用途：`run_command` 是权限模型中唯一能同时绕过路径约束与 SSRF 防护的路径，
 * 命令字符串中的路径不经过文件工具的路径解析（`resolveInWorkspace`）。在其上叠加的静态规则
 * （`agent` 的 `decideCommand`）是文本判断，只覆盖已列举的写法，而可能的写法无法穷举。
 *
 * 内核层的边界与命令文本无关，只取决于系统调用访问的 inode。
 * 因此本文件的目标不是再增加一层规则，而是把边界从文本层移到内核层。
 *
 * 前提是包装点唯一，因此收敛为一个函数。`Bun.spawn` 分散在两处时，
 * 添加沙箱必须同时修改两处，遗漏的一处不会报错，只是没有边界。
 *
 * 沙箱的探测与参数生成见 `sandbox.ts`。如需更换实现，在本文件的 `spawnGuarded` 中接入，不要新增第二个 spawn 入口。
 */

import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
// 临时脚本位于本机文件系统，使用平台原生的拼接。
import { join as joinNative } from 'node:path'
import { type CommandRunner, type ProcessInput, type ProcessLike, sinkInput } from '../runner.ts'
import { type CommandShell, probeBash } from './command-shell.ts'
import {
  buildBwrapArgv,
  buildSeatbeltArgv,
  detectSandbox,
  type SandboxPolicy,
  type SandboxStatus,
} from './sandbox.ts'

/**
 * 启动子进程的两种输入：交给 shell 执行的命令，或直接执行的参数数组。
 *
 * 参数数组供产品自身的执行程序使用（`office` 的 Python worker）：程序与参数均由产品确定，
 * 模型代码经文件传递，不经 shell 转义。两种输入共用下方的沙箱、runner 与返回结构。
 */
export type GuardedSpawnInput = GuardedSpawnCommon &
  (
    | {
        /** 调用方选定的解释器，必须与命令语法及工具说明一致。 */
        shell: CommandShell | null
        /** 要执行的命令原文。由调用方保证已经过裁决。 */
        command: string
      }
    | {
        /** 可执行文件的绝对路径在前，其后是参数。 */
        argv: readonly string[]
      }
  )

interface GuardedSpawnCommon {
  /** 已解析的绝对工作目录。 */
  cwd: string
  /** 已剥离凭证的环境变量。本函数不做脱敏，由调用方负责。 */
  env: Record<string, string>
  /**
   * 沙箱策略。`null` 表示明确不使用沙箱（插件的 `exec.run` 使用独立的隔离机制）。
   *
   * 传入 `null` 与本机没有沙箱是两种情况，返回的 `sandbox.reason`
   * 分别说明；合并为「无沙箱」时，排查中无法区分配置问题与环境问题。
   */
  policy: SandboxPolicy | null
  /**
   * 保留标准输入管道，返回值的 `input` 为其写端。缺省关闭标准输入：读取输入的程序立即读取到输入结束，
   * 不会无人响应地等待至超时。
   */
  input?: boolean
}

export interface GuardedSpawn {
  /**
   * 两条输出流、退出码与 pid，满足 `collectProcess` 和 `killTree` 的需要。
   *
   * 该字段有两个实现：本进程直接 spawn 的 `Bun.Subprocess`，以及由 runner
   * 代为执行的进程（`runner.ts`）。后者用于确定父进程：命令必须运行在一个
   * 先于监听端口启动的进程之下，否则其派生的后台服务会继承并占用监听端口。
   */
  proc: ProcessLike
  sandbox: SandboxStatus
  /** 标准输入的写端；未请求输入管道时为 null。 */
  input: ProcessInput | null
}

/**
 * 命令的父进程由谁担任。
 *
 * 这是进程级的事实，因此使用进程级变量：进程要么绑定了监听端口（此时必须经由
 * runner），要么没有（直接 spawn 即可）。它不随调用方、会话、工作区变化，
 * 作为参数逐层传递只会把同一个事实复制多份。
 *
 * `qy serve` 在绑定端口之前注册；`qy exec` 与测试进程不注册，直接 spawn。
 */
let runner: CommandRunner | null = null

export function setCommandRunner(next: CommandRunner | null): void {
  runner = next
}

/** 在沙箱与 runner 之内实际执行的 argv；命令输入在 Windows 上另有一个随进程退出删除的脚本文件。 */
async function innerArgv(
  input: GuardedSpawnInput,
  isWindows: boolean,
): Promise<{ inner: string[]; scriptPath: string | null }> {
  if ('argv' in input) return { inner: [...input.argv], scriptPath: null }

  // 没有任何 shell 时 `run_command` 不注册，因此正常路径不会到达此处；
  // 插件的 `exec.run` 调用同一函数，需要明确的错误信息，而不是在构造 argv 时崩溃。
  const shell = input.shell
  if (shell === null) {
    // 报告 bash 的原因：三种 shell 中只有它能给出下一步操作（安装 Git for Windows），
    // 另外两种只能说明本机没有，没有可执行的下一步。
    throw new Error(
      `没有可用的 shell（bash / pwsh / powershell 均未找到），无法执行命令：${probeBash().reason}`,
    )
  }

  /*
   * 命令原样交给 shell，不做转义处理，与 shell.ts 的约定一致：
   * 转义黑名单无法拦截构造出的命令，实际边界在内核层。
   *
   * 原样传递的前提是命令能原样到达。Windows 上 argv 需要经过一次命令行字符串的转换，
   * 成对的反斜杠在 MSYS 一侧会被去除一半（见 `CommandShell.scriptArgv`）。因此 bash
   * 改为经脚本文件传递：命令正文不进入 argv，逐字节到达。
   */
  const scriptRun = isWindows ? shell.scriptArgv : undefined
  const scriptPath = scriptRun ? joinNative(tmpdir(), `qy-cmd-${randomUUID()}.sh`) : null
  if (scriptPath) await writeFile(scriptPath, input.command, 'utf8')
  const inner =
    scriptRun && scriptPath ? [...scriptRun(scriptPath)] : [...shell.argv, input.command]
  return { inner, scriptPath }
}

/**
 * 本项目中为模型给出的命令启动子进程的唯一位置。
 *
 * 新增调用方之前须确认：绕过此处即绕过沙箱，且不会有任何报错。
 */
export async function spawnGuarded(input: GuardedSpawnInput): Promise<GuardedSpawn> {
  const status = detectSandbox()
  const isWindows = process.platform === 'win32'
  const { inner, scriptPath } = await innerArgv(input, isWindows)
  const policy = input.policy

  const argv =
    policy === null || status.backend === 'none'
      ? inner
      : status.backend === 'bwrap'
        ? buildBwrapArgv(policy, inner, { cwd: input.cwd })
        : buildSeatbeltArgv(policy, inner)

  const effective: SandboxStatus =
    input.policy === null
      ? { ...status, active: false, reason: '本次调用显式不使用沙箱（插件 exec 使用独立隔离）' }
      : status

  /**
   * 脚本文件的生命周期与进程一致：进程退出后删除。
   *
   * 不在返回前删除：此时命令尚未开始读取。删除失败也不抛出异常：临时目录中残留一个数百字节
   * 的文件，好于因清理失败把一次成功的命令报告为失败。
   */
  const sweep = (proc: { exited: Promise<unknown> }): void => {
    if (!scriptPath) return
    void proc.exited.then(() => rm(scriptPath, { force: true }).catch(() => {}))
  }

  // 有 runner 时由它担任父进程（理由见 `runner.ts` 的模块注释）。
  if (runner) {
    const proc = await runner.spawn({
      argv,
      cwd: input.cwd,
      env: input.env,
      detached: !isWindows,
      input: input.input === true,
    })
    sweep(proc)
    return { proc, sandbox: effective, input: proc.input }
  }

  /*
   * 三个流的类型显式声明，不依赖推断：带 spread 的字面量会被推断为
   * `'inherit'`，`proc.stderr` 因此可能为 undefined，而读取它的代码在其他文件中。
   */
  const opts = {
    cwd: input.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    // 未请求输入管道时关闭 stdin：交互式提示在此处无人响应，只会等待至超时。
    stdin: input.input === true ? 'pipe' : 'ignore',
    env: input.env,
    /*
     * 非 Windows 平台上子进程自成进程组，`killTree` 才能终止整个进程组。
     *
     * 否则它与 `qy serve` 同组，按其 pid 无法定位进程组，`killTree`
     * 只能终止 shell 本身，shell 派生的子孙进程继续运行。
     *
     * Windows 不设置：Windows 由 `taskkill /T` 遍历进程树，不需要进程组语义，
     * 且 detached 在 Windows 上表示脱离控制台，与此处目的无关。
     */
    ...(isWindows ? {} : { detached: true }),
  } as Bun.SpawnOptions.OptionsObject<'pipe' | 'ignore', 'pipe', 'pipe'>

  const proc = Bun.spawn(argv, opts)
  sweep(proc)
  return {
    proc,
    sandbox: effective,
    input: input.input === true ? sinkInput(proc.stdin as Bun.FileSink) : null,
  }
}
