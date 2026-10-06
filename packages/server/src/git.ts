/**
 * 当前分支名：输入框上方分支标签的数据源。
 *
 * **只返回分支名。** 改动数、暂存数、领先落后、文件清单都不在这里：它们回答的是
 * 「工作区相对 HEAD 有什么差别」，而界面上没有任何一处需要该信息。
 * 「该会话修改了哪些文件」由 step 账本回答（`apps/web` 的 `ChangeRecord`）。
 *
 * 直接以子进程调用 `git`，不使用 isomorphic-git：git 本身才是权威实现，
 * 任何 JS 重新实现在 worktree、submodule、稀疏检出、LFS、hooks 上都会存在差异。
 *
 * 加 `--no-optional-locks`：该命令会周期性刷新，不能因读取状态而占用
 * index.lock，否则用户在终端中执行 `git commit` 会随机失败。
 */

import { collectProcess } from '@qywork/tools'

async function git(
  cwd: string,
  args: string[],
  timeoutMs = 15_000,
): Promise<{ ok: boolean; out: string; err: string }> {
  // 显式写出三条流的类型：使用 `ReturnType<typeof Bun.spawn>` 会退化为默认泛型，
  // `proc.stdout` 变为 `number | ReadableStream | undefined`，下方读取流的代码无法通过编译。
  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  try {
    proc = Bun.spawn(['git', '--no-optional-locks', ...args], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
      env: { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    })
  } catch (e) {
    /*
     * **本机未安装 git。**
     *
     * `Bun.spawn` 未找到可执行文件时**同步抛出**，而广播分支名的几处都是
     * `void publishGitState(...)` 形式的浮动 promise：不捕获时，在没有 git 的机器上
     * 每次广播都产生一个未捕获的拒绝，启动时即输出大量调用栈。实测（把 PATH 裁剪到只剩
     * System32 后启动一次服务）得到的正是这一形状。
     *
     * 在这里处理而不是在调用方加 `.catch`：后者是在下游掩盖症状，而「git 能否运行」
     * 本就属于该函数的返回类型，它已有 `ok: false` 分支，调用方已经处理。
     * 因此「未安装 git」与「不是仓库」经由同一条路径：分支标签不显示，其余功能正常。
     * 界面上的说明由 `api/host.ts` 的环境清单负责。
     */
    return { ok: false, out: '', err: e instanceof Error ? e.message : String(e) }
  }
  // 等待与收尾经由同一处统一处理：完成判据是进程退出而不是管道 EOF，超时时**终止整个进程树**。
  // 该命令不触发 hook、不访问网络、也不会启动 pager，因此孤儿进程占用管道的路径当前不可达；
  // 一旦开启 `core.fsmonitor` 即可达，此时 git 会留下一个常驻守护进程。
  const got = await collectProcess(proc, { timeoutMs })
  return { ok: got.exitCode === 0, out: got.stdout, err: got.stderr }
}

/**
 * 当前分支名。不是仓库、未安装 git、detached HEAD 时都返回 null。
 *
 * 使用 `--show-current` 而不是 `rev-parse --abbrev-ref HEAD`：后者在 detached 时
 * 返回字符串 `HEAD`，会被当作名为 HEAD 的分支显示。
 * **detached 返回 null 是有意设计**：该状态下没有分支名可显示，而在输入框上方显示
 * 「(detached)」并不能让用户执行任何操作。
 */
export async function currentBranch(cwd: string): Promise<string | null> {
  const r = await git(cwd, ['branch', '--show-current'])
  if (!r.ok) return null
  const name = r.out.trim()
  return name || null
}

/**
 * 该工作树自身的 git 目录（绝对路径），`HEAD` 位于其中。不是仓库、未安装 git 时都返回 null。
 *
 * 不要拼接 `<root>/.git`：链接工作树与子模块中的 `.git` 是一个内容为 `gitdir: …` 的文件，
 * 项目位于仓库子目录时 `<root>/.git` 不存在。
 */
export async function gitDir(cwd: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', '--absolute-git-dir'])
  if (!r.ok) return null
  return r.out.trim() || null
}

/** 本地分支。**只有名称与是否为当前分支**：界面上不需要其他字段。 */
export interface Branch {
  name: string
  current: boolean
}

/** 本地分支清单，不含远程分支：切换到远程分支需要先创建本地跟踪分支，不属于本函数的范围。 */
export async function branches(cwd: string): Promise<Branch[]> {
  const r = await git(cwd, ['for-each-ref', '--format=%(HEAD)%09%(refname:short)', 'refs/heads'])
  if (!r.ok) return []
  const out: Branch[] = []
  for (const line of r.out.split('\n')) {
    const [head, name] = line.split('\t')
    if (!name) continue
    out.push({ name, current: head === '*' })
  }
  return out
}

/**
 * 切换到另一条本地分支。
 *
 * **先在清单中核对名称再执行。** `name` 来自 HTTP，最终作为独立的 argv 传给 git；
 * 这不是 shell 注入（`git()` 接收的是数组），但 git 会把以 `-` 开头的值解析为选项，
 * 例如 `--output=<path>` 能让 git 向任意路径写入文件。按清单核对比按字符集
 * 校验更严格：只能切换到当前实际存在的本地分支。
 *
 * 使用 `switch` 而不是 `checkout`：后者的参数既可以是分支也可以是路径，
 * 一个恰好与分支同名的文件会使它还原文件而不是切换分支。
 *
 * **失败时必须带回「哪些文件阻止了切换」**（`refusal`）：那是用户唯一能处理的地方，
 * 压缩为一句「切换失败」等于删除线索。
 */
export async function switchTo(
  cwd: string,
  name: string,
): Promise<{ ok: boolean; message: string }> {
  if (!(await branches(cwd)).some((b) => b.name === name)) {
    return { ok: false, message: `本地分支不存在：${name}` }
  }
  const r = await git(cwd, ['switch', name])
  return r.ok ? { ok: true, message: '' } : { ok: false, message: refusal(r.err) }
}

/**
 * 把 git 拒绝切换时的输出转换为一句中文。
 *
 * **能够识别是因为 `git()` 固定了 `LC_ALL=C`**，输出始终是这两种英文形状；去掉该环境变量后，
 * 这里会全部进入原样返回的分支：不会转换错误，只是不转换。
 *
 * **无法识别时原样返回英文。** 自行构造一句「切换失败」等于删除用户唯一的线索：
 * git 在这里报告的是「哪些文件阻止了切换」，那正是用户需要处理的地方。
 */
function refusal(stderr: string): string {
  const raw = stderr.trim()
  // 被列出的文件是带缩进的行；git 使用制表符缩进。
  const files = raw
    .split('\n')
    .filter((l) => l.startsWith('\t'))
    .map((l) => l.trim())
  if (files.length === 0) return raw || '切换失败'
  const list =
    files.length > 3
      ? `${files.slice(0, 3).join('、')} 等 ${files.length} 个文件`
      : files.join('、')

  if (raw.includes('local changes to the following files')) {
    return `${list} 有未提交的改动，请先提交再切换`
  }
  if (raw.includes('untracked working tree files')) {
    return `${list} 未被跟踪，请先移除再切换`
  }
  return raw
}
