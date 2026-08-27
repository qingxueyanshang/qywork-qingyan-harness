/**
 * 当前分支名——输入框上方那颗分支牌的数据源，也是这个仓库里唯一用到 git 的地方。
 *
 * **只回分支名。** 改动数、暂存数、领先落后、文件清单都不在这里：那些回答的是
 * 「工作区相对 HEAD 有什么差别」，而界面上没有任何一处在问这个问题。
 * 「这条会话改了哪些文件」由 step 账本回答（`apps/web` 的 `ChangeRecord`）。
 *
 * 直接 shell 出 `git`，不用 isomorphic-git：git 自己才是它的权威实现，
 * 任何 JS 复刻在 worktree、submodule、稀疏检出、LFS、hooks 上都会有出入。
 *
 * 加 `--no-optional-locks`：这条命令是周期性刷新的，不能因为读状态而去抢
 * index.lock，否则用户在终端里 `git commit` 会随机失败。
 */

import { collectProcess } from '@qywork/tools'

async function git(
  cwd: string,
  args: string[],
  timeoutMs = 15_000,
): Promise<{ ok: boolean; out: string; err: string }> {
  // 显式写出三条流的形态：用 `ReturnType<typeof Bun.spawn>` 会退化成默认泛型，
  // `proc.stdout` 变成 `number | ReadableStream | undefined`，下面读流就编译不过。
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
     * **这台机器上没装 git。**
     *
     * `Bun.spawn` 找不到可执行文件是**同步抛**，而广播分支名那几处都是
     * `void publishGitState(...)` 这样的浮动 promise——不接住的话，没有 git 的机器上
     * 每广播一次就是一个未捕获拒绝，启动时先糊一屏栈。实测（把 PATH 剥到只剩
     * System32 起一次服务）就是这个形状。
     *
     * 接在这里而不是在调用方加 `.catch`：那是在下游堵症状，而「git 跑不跑得起来」
     * 本来就属于这个函数的返回类型——它已经有 `ok: false` 这一档，调用方在处理。
     * 因此「没装 git」和「这不是个仓库」走同一条路：分支牌不显示，其余功能照常。
     * 界面上要说明的那句由 `api/host.ts` 的环境清单负责。
     */
    return { ok: false, out: '', err: e instanceof Error ? e.message : String(e) }
  }
  // 等待与收尾走同一个收口：完成判据是进程退出而不是管道 EOF，超时走**树杀**。
  // 这条命令不触发 hook、不联网、也不会起 pager，所以孤儿扣管道那条路当前走不到；
  // `core.fsmonitor` 一旦开着就走得到，那时 git 会留下一个常驻守护进程。
  const got = await collectProcess(proc, { timeoutMs })
  return { ok: got.exitCode === 0, out: got.stdout, err: got.stderr }
}

/**
 * 当前分支名。不是仓库、没装 git、detached HEAD 都回 null。
 *
 * 用 `--show-current` 而不是 `rev-parse --abbrev-ref HEAD`：后者在 detached 时
 * 回字符串 `HEAD`，那会被当成一个叫 HEAD 的分支显示出来。
 * **detached 回 null 是有意的**——那个状态下没有分支名可显示，而挂一句
 * 「(detached)」在输入框上方并不能让用户做任何事。
 */
export async function currentBranch(cwd: string): Promise<string | null> {
  const r = await git(cwd, ['branch', '--show-current'])
  if (!r.ok) return null
  const name = r.out.trim()
  return name || null
}

/** 本地分支。**只有名字和是不是当前那条**——界面上没有别的字段在问。 */
export interface Branch {
  name: string
  current: boolean
}

/** 本地分支清单，不含远程分支：切到远程分支要先建本地跟踪分支，那是另一件事。 */
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
 * 切到另一条本地分支。
 *
 * **先在清单里核一遍名字再执行。** `name` 来自 HTTP，最终作为独立 argv 传给 git；
 * 这不是 shell 注入（`git()` 收的是数组），但 git 自己会把以 `-` 开头的值按选项
 * 解析——`--output=<path>` 那一档能让 git 往任意路径写文件。按清单核比按字符集
 * 正面校验更严：能切过去的只有此刻真实存在的本地分支。
 *
 * 用 `switch` 而不是 `checkout`：后者的参数既可以是分支也可以是路径，
 * 一个正好和分支同名的文件会让它去还原文件而不是切分支。
 *
 * **失败必须把「是哪几个文件挡着」带回去**（`refusal`）——那是用户唯一能动手的地方，
 * 缩成一句「切换失败」等于把线索删掉。
 */
export async function switchTo(
  cwd: string,
  name: string,
): Promise<{ ok: boolean; message: string }> {
  if (!(await branches(cwd)).some((b) => b.name === name)) {
    return { ok: false, message: `没有这条本地分支：${name}` }
  }
  const r = await git(cwd, ['switch', name])
  return r.ok ? { ok: true, message: '' } : { ok: false, message: refusal(r.err) }
}

/**
 * git 拒绝切换时的那句话，翻成一句中文。
 *
 * **认得住是因为 `git()` 钉了 `LC_ALL=C`**，输出永远是这两种英文形状；哪天有人去掉
 * 那个环境变量，这里就会全部落到原样返回那一支——不会翻错，只会不翻。
 *
 * **认不出的原样返回英文。** 编一句「切换失败」出来等于把用户唯一的线索删掉：
 * git 在这里说的是「是哪几个文件挡着」，那正是他要动手的地方。
 */
function refusal(stderr: string): string {
  const raw = stderr.trim()
  // 被点名的文件是缩进那几行；git 用制表符缩进。
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
    return `${list} 有未提交的改动，先提交再切`
  }
  if (raw.includes('untracked working tree files')) {
    return `${list} 没跟踪，先挪走再切`
  }
  return raw
}
