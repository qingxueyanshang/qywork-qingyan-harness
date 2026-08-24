/**
 * 本机装了哪些外部 agent CLI，以及它接没接入。
 *
 * ## 为什么内置一张表
 *
 * 让用户填「命令、参数模板、输出格式、结果字段」这四项，实测的结果是这一段没人用：
 * 填错了要等到编排跑到一半才报错，而正确答案只能去各家文档里翻。所以改成认表：
 * 表里只收**几家模型厂商自己的 code CLI**，别家不收。
 *
 * 代价明写在这里：表会过期。某家改了调用参数，这里就调不动它；某家改了凭证存放位置，
 * 这里就把已经登录的那条报成「未接入」。两种都表现为界面上少一条或状态不对，
 * 不会表现为跑到一半失败——**加新的一家就往 `KNOWN` 里加一条**。
 *
 * ## 「接入」的判据是凭证，不是能不能跑
 *
 * 真要确认接没接上，唯一可靠的办法是拿它跑一次——那要花钱、要几十秒，
 * 而这是一个打开设置页就该出结果的探测。所以判据取「见没见到凭证」：
 * 环境变量有值，或者那家的凭证文件在。
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
    // `stream-json` 而不是 `json`：后者跑完才一次性吐一个大对象，右侧面板里
    // 那一页在它结束之前一个字都没有。`--verbose` 是 stream-json 在打印模式下的前提。
    //
    // `--permission-mode acceptEdits` 不是可选项：不给的话它在打印模式下**一个字节都写不了**，
    // 而且照样报「做完了」。实测（2026-08-24）派它建一个文件加改一行，四种写法
    // （Write / Edit / Bash 重定向 / PowerShell）全被它自己的权限闸拦下，
    // 回执里写着「改了哪些文件：没有」。stdin 是关的，那道闸没有人能应答。
    // 它接受的只是**工作目录内的编辑**，边界与派活给它这件事本身同宽。
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
    envKeys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
    credentials: ['.claude/.credentials.json', '.claude.json'],
  },
  {
    id: 'codex',
    vendor: 'OpenAI',
    bin: 'codex',
    // `--skip-git-repo-check` 不是可选项：codex 默认拒绝在非 git 目录里跑
    // （原话「Not inside a trusted directory」），于是派给它的节点在任何一个
    // 不是 git 仓库的工作区里必然失败。工作区是用户自己选的、模型是他自己派的，
    // 这层判断该由 qywork 的权限模式管，不该由被调度的 CLI 再拦一道。
    args: ['exec', '--json', '--skip-git-repo-check', '{prompt}'],
    output: 'jsonl',
    // 答案在 `item.completed` 那种行的 `item.text` 上，顶层没有 `result`。
    resultField: 'item.text',
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
    args: ['-p', '{prompt}'],
    output: 'text',
    envKeys: ['XAI_API_KEY'],
    credentials: ['.grok/auth.json'],
  },
  {
    id: 'kimi',
    vendor: '月之暗面',
    bin: 'kimi',
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
