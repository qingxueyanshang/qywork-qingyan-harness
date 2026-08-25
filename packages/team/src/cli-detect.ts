/**
 * 本机装了哪些外部 agent CLI，以及它接没接入。
 *
 * **为什么内置一张表。** 让用户填「命令、参数模板、输出格式、结果字段」这四项，实测的结果是这一段没
 * 人用：填错了要等到编排跑到一半才报错，而正确答案只能去各家文档里翻。所以改成认表：表里只收**几
 * 家模型厂商自己的 code CLI**，别家不收。
 *
 * 代价明写在这里：表会过期。某家改了调用参数，这里就调不动它；某家改了凭证存放位置，
 * 这里就把已经登录的那条报成「未接入」。两种都表现为界面上少一条或状态不对，
 * 不会表现为跑到一半失败——**加新的一家就往 `KNOWN` 里加一条**。
 *
 * **「接入」的判据是凭证，不是能不能跑。** 真要确认接没接上，唯一可靠的办法是拿它跑一次——那要花
 * 钱、要几十秒，而这是一个打开设置页就该出结果的探测。所以判据取「见没见到凭证」：环境变量有值，
 * 或者那家的凭证文件在。
 */

import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import type { CliAgent } from './types.ts'

interface KnownCli extends Omit<CliAgent, 'command'> {
  /** PATH 上要找的名字。 */
  bin: string
  /** 这几个环境变量任一有值就算接入。 */
  envKeys: string[]
  /** 家目录下这几个路径任一存在就算接入。 */
  credentials: string[]
}

/**
 * 认得的几家。**只收模型厂商自己的 code CLI**——编辑器厂商、社区包装不收：
 * 收进来就要跟着它们各自的参数演进，而它们没有稳定的非交互调用约定。
 */
const KNOWN: KnownCli[] = [
  {
    id: 'claude',
    vendor: 'Anthropic',
    bin: 'claude',
    // `-p` 是它的非交互调用：给一段提示词、跑完就退出。派活只能这么调——
    // 它跑在服务端，没有人坐在那儿回答它的问题。
    //
    // `stream-json` 而不是 `json`：后者跑完才一次性返回一个大对象，右侧面板里
    // 那一页在它结束之前一个字都没有。`--verbose` 是 stream-json 在 `-p` 下的前提。
    //
    // `--permission-mode acceptEdits` 不是可选项：不给的话它**一个字节都写不了**。
    // 实测（2026-08-24）派它建一个文件加改一行，四种写法（Write / Edit / Bash 重定向 /
    // PowerShell）全被它自己的权限闸拦下，原话「requested permissions to write … but you
    // haven't granted it yet」——stdin 是关的，那道闸没有人能应答。**它退出码仍是 0**，
    // 因此这一侧照样算它做成了。它接受的只是工作目录内的编辑，边界与派活这件事本身同宽。
    args: [
      '-p',
      '{prompt}',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
    ],
    output: 'jsonl',
    resultField: 'result',
    // 会话 id 在顶层 `session_id` 上（`system/init` 与 `result` 两行都带）。
    // **不能写 `result.session_id`**：末行那个 `result` 是答案正文，是字符串不是对象。
    sessionField: 'session_id',
    // `--resume` 按它的帮助只在 `--print` 下有效，正是派活这条路。实测接着问
    // 「你刚才改了哪些文件」，它凭记忆答得出来，没有重新去读文件。
    resumeArgs: [
      '-p',
      '{prompt}',
      '--resume',
      '{session}',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
    ],
    envKeys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
    credentials: ['.claude/.credentials.json', '.claude.json'],
  },
  {
    id: 'codex',
    vendor: 'OpenAI',
    bin: 'codex',
    // `--skip-git-repo-check` 不是可选项：codex 默认拒绝在非 git 目录里跑
    // （原话「Not inside a trusted directory」），因此派给它的节点在任何一个
    // 不是 git 仓库的工作区里必然失败。工作区是用户自己选的、模型是他自己派的，
    // 这层判断该由 qywork 的权限模式管，不该由被调度的 CLI 再拦一道。
    args: ['exec', '--json', '--skip-git-repo-check', '{prompt}'],
    output: 'jsonl',
    // 答案在 `item.completed` 那种行的 `item.text` 上，顶层没有 `result`。
    resultField: 'item.text',
    // 会话 id 在第一行 `thread.started` 的顶层 `thread_id` 上。
    sessionField: 'thread_id',
    resumeArgs: ['exec', 'resume', '{session}', '--json', '--skip-git-repo-check', '{prompt}'],
    envKeys: ['OPENAI_API_KEY'],
    credentials: ['.codex/auth.json'],
  },
  {
    id: 'gemini',
    vendor: 'Google',
    bin: 'gemini',
    args: ['-p', '{prompt}'],
    output: 'text',
    envKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    credentials: ['.gemini/oauth_creds.json'],
  },
  {
    id: 'qwen',
    vendor: '阿里云',
    bin: 'qwen',
    args: ['-p', '{prompt}'],
    output: 'text',
    envKeys: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY'],
    credentials: ['.qwen/oauth_creds.json'],
  },
  {
    id: 'grok',
    vendor: 'xAI',
    bin: 'grok',
    // `-p` 是它的 `--single`：跑一轮打印结果就退出。默认它是个 TUI。
    //
    // `--output-format json` 出来的是**一个**缩进过的对象（不是逐行），所以走 `json` 那一档；
    // 逐行解析对它一行都取不到。
    //
    // **`--always-approve` 不能换成 `--permission-mode acceptEdits`**：实测（2026-08-25）
    // 后者会让它在第一次工具调用处停下，回来的对象是 `stopReason: "cancelled"`、`num_turns: 1`，
    // 正文写着「正在创建 g1.txt」而文件没有。stdin 是关的，没有人能批准那一次调用。
    args: ['-p', '{prompt}', '--output-format', 'json', '--always-approve'],
    output: 'json',
    resultField: 'text',
    sessionField: 'sessionId',
    resumeArgs: [
      '-p',
      '{prompt}',
      '--resume',
      '{session}',
      '--output-format',
      'json',
      '--always-approve',
    ],
    envKeys: ['XAI_API_KEY'],
    credentials: ['.grok/auth.json'],
  },
  {
    id: 'kimi',
    vendor: '月之暗面',
    bin: 'kimi',
    // **不要加 `--auto` 或 `-y/--yolo`**：实测（2026-08-25）它当场拒绝，
    // 原话「Cannot combine --prompt with --auto」，因此每一次派活都以退出码 1 收场。
    //
    // 它**有** `--output-format stream-json` 与 `-S/--session <id>`，所以接着问这条路存在，
    // 但那两项要填进表里得先看一次成功的输出。**这台机器上采不到**：它的服务端对
    // 四个模型别名（kimi-for-coding / -highspeed / k3 / k3-256k）全部回 500
    // （`APIStatusError`，它自己重试到第 10 次放弃），流里只见得到 `turn.step.retrying`。
    // 已知的形状只有事件信封是 `{ role, type, … }`。**采到之前不猜**：
    // 猜错的表现是「表里写着能接着问，跑起来取不到 id」。
    args: ['-p', '{prompt}'],
    output: 'text',
    envKeys: ['KIMI_API_KEY'],
    credentials: ['.kimi-code/credentials/kimi-code.json'],
  },
]

export interface DetectedCli extends CliAgent {
  /** 解析出来的可执行文件绝对路径。 */
  path: string
  /** 见到凭证了。见文件头：判的是凭证在不在，不是真的跑通了。 */
  connected: boolean
}

/**
 * 扫一遍 PATH，返回装着的那几家。没装的**不出现在结果里**。
 *
 * `env` 可注入是为了测试；生产上就是 `process.env`。
 */
export async function detectClis(env: NodeJS.ProcessEnv = process.env): Promise<DetectedCli[]> {
  const home = homedir()
  const found: DetectedCli[] = []
  for (const k of KNOWN) {
    const path = await resolveOnPath(k.bin, env)
    if (!path) continue
    found.push({
      id: k.id,
      vendor: k.vendor,
      command: path,
      args: k.args,
      output: k.output,
      ...(k.resultField ? { resultField: k.resultField } : {}),
      // 这两项漏抄的话「接着问」会静默失效：表里写着，跑起来却没有。
      ...(k.sessionField ? { sessionField: k.sessionField } : {}),
      ...(k.resumeArgs ? { resumeArgs: k.resumeArgs } : {}),
      ...(k.timeoutMs ? { timeoutMs: k.timeoutMs } : {}),
      path,
      connected: await hasCredentials(k, home, env),
    })
  }
  return found
}

/** 按 id 取一条识别结果，给编排与工具用。没装或不认识的返回 undefined。 */
export async function findCli(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DetectedCli | undefined> {
  return (await detectClis(env)).find((c) => c.id === id)
}

async function hasCredentials(k: KnownCli, home: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (k.envKeys.some((key) => (env[key] ?? '').trim() !== '')) return true
  for (const rel of k.credentials) {
    if (await exists(join(home, ...rel.split('/')))) return true
  }
  return false
}

/**
 * 在 PATH 上找一个命令，返回绝对路径。
 *
 * **Windows 上必须自己按后缀试。** 同一个名字在 PATH 上往往有三个入口
 * （`x`、`x.cmd`、`x.exe`），无后缀的那个是 sh 脚本，交给 Windows 起进程会失败；
 * 按 PATHEXT 的顺序找出真正能执行的那个，路径也要落到绝对路径上——
 * 相对名字会让子进程继承一次 PATH 查找，结果可能与这里探到的不是同一个文件。
 */
async function resolveOnPath(bin: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)
  const exts =
    process.platform === 'win32'
      ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : ['']
  for (const dir of dirs) {
    const base = isAbsolute(dir) ? dir : null
    if (!base) continue
    for (const ext of exts) {
      const p = join(base, bin + ext.toLowerCase())
      if (await exists(p)) return p
    }
    // POSIX 上没有后缀这一说；Windows 上无后缀的那个也要认（可能是真的可执行文件）。
    if (process.platform === 'win32' && (await exists(join(base, bin)))) return join(base, bin)
  }
  return null
}

async function exists(p: string): Promise<boolean> {
  return await access(p).then(
    () => true,
    () => false,
  )
}
