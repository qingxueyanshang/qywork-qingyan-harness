/**
 * 识别本机已安装的外部 agent CLI 及其接入状态。
 *
 * **使用内置厂商表的原因。** 由用户填写命令、参数模板、输出格式、结果字段四项时，实测该功能无人
 * 使用：填写错误要到编排执行中途才报错，而正确值只能从各厂商文档中查找。因此采用内置表，表中只收录
 * **模型厂商自身的 code CLI**，不收录其他厂商。
 *
 * 代价：厂商表会过期。某厂商修改调用参数后，此处无法调用该 CLI；修改凭证存放位置后，
 * 已登录的 CLI 会被报告为「未见凭证」。参数变化可能在实际执行时报错。
 * **新增厂商时在 `KNOWN` 中增加一项，并核对输出与终态协议**。
 *
 * **「接入」的判据是凭证，不是能否运行。** 确认接入的唯一可靠方法是实际运行一次，而这会产生
 * 费用并耗时数十秒，但该探测需要在打开设置页时立即给出结果。因此判据为是否检测到凭证：环境变量有值，
 * 或该厂商的凭证文件存在。
 */

import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import type { CliAgent } from './types.ts'

interface KnownCli extends Omit<CliAgent, 'command'> {
  /** 在 PATH 上查找的命令名。 */
  bin: string
  /** 其中任一环境变量有值即视为已接入。 */
  envKeys: string[]
  /** 家目录下其中任一路径存在即视为已接入。 */
  credentials: string[]
}

/**
 * 已知的 CLI。**只收录模型厂商自身的 code CLI**，不收录编辑器厂商与社区封装：
 * 收录后须跟随其参数变化，而它们没有稳定的非交互调用约定。
 */
const KNOWN: KnownCli[] = [
  {
    id: 'claude',
    vendor: 'Anthropic',
    bin: 'claude',
    // `-p` 是其非交互调用方式：传入一段提示词，执行完毕即退出。派发任务只能使用这种方式：
    // CLI 运行在服务端，无人应答其提问。
    //
    // 使用 `stream-json` 而不是 `json`：后者执行完毕才一次性返回一个大对象，右侧面板中
    // 对应页面在执行结束之前没有任何内容。`--verbose` 是 `-p` 模式下使用 stream-json 的前提。
    //
    // `--permission-mode acceptEdits` 是必需参数：不传入时它**无法写入任何字节**。
    // 实测（2026-08-24）派发任务要求它创建一个文件并修改一行，四种写法（Write / Edit / Bash 重定向 /
    // PowerShell）均被其自身的权限检查拦截，原文「requested permissions to write … but you
    // haven't granted it yet」：stdin 已关闭，无人能应答该权限请求。其退出码可能仍为 0，
    // 因此执行器还须检查 result 终态；具体工具权限仍由 Claude 自身的配置决定。
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
    protocol: 'claude',
    resultField: 'result',
    // 正文与工具名都在 `assistant` 类型行的内容块数组中：文本块有 `text`，
    // 工具调用块有 `name`。不声明这两条路径时，实时页显示的是 `thinking_tokens`
    // 等计数事件的原始 JSON 行，且没有 `result` 行时回执无法取得正文。
    narrate: { text: 'message.content[].text', tool: 'message.content[].name' },
    // 会话 id 在顶层 `session_id` 上（`system/init` 与 `result` 两行都有）。
    // **不能写 `result.session_id`**：末行的 `result` 是答案正文，是字符串而不是对象。
    sessionField: 'session_id',
    // 按其帮助说明，`--resume` 只在 `--print` 下有效，即派发任务所用的调用方式。实测续问
    // 「你刚才改了哪些文件」时，它依据会话记录作答，未重新读取文件。
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
    // `--skip-git-repo-check` 是必需参数：codex 默认拒绝在非 git 目录中运行
    // （原文「Not inside a trusted directory」），因此派发给它的节点在任何
    // 非 git 仓库的工作区中必然失败。工作区由用户选择，派发由用户的模型发起，
    // 该判断应由 qywork 的权限模式负责，不应由被调度的 CLI 再次拦截。
    // 派发任务允许修改当前工作区。显式指定写入沙箱，避免落入 CLI 默认的只读模式。
    args: ['exec', '--sandbox', 'workspace-write', '--json', '--skip-git-repo-check', '{prompt}'],
    output: 'jsonl',
    protocol: 'codex',
    // 答案在 `item.completed` 类型行的 `item.text` 上，顶层没有 `result`。
    resultField: 'item.text',
    // 中途的每条 `item.text` 都是该步骤的输出，正文路径与答案路径相同；
    // 工具名不在该路径下（命令行在 `item.command` 上），因此只声明正文。
    narrate: { text: 'item.text' },
    // 会话 id 在第一行 `thread.started` 的顶层 `thread_id` 上。
    sessionField: 'thread_id',
    // sandbox 属于 exec 的参数，放在 resume 之前，首次与续接使用同一权限范围。
    resumeArgs: [
      'exec',
      '--sandbox',
      'workspace-write',
      'resume',
      '{session}',
      '--json',
      '--skip-git-repo-check',
      '{prompt}',
    ],
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
    // `-p` 等同于其 `--single`：执行一轮、打印结果后退出。默认模式是 TUI。
    //
    // `--output-format json` 输出的是**一个**缩进过的对象（不是逐行），因此使用 `json` 格式；
    // 逐行解析无法取得任何一行。
    //
    // **`--always-approve` 不能换成 `--permission-mode acceptEdits`**：实测（2026-08-25）
    // 后者会使其在第一次工具调用处停止，返回的对象为 `stopReason: "cancelled"`、`num_turns: 1`，
    // 正文为「正在创建 g1.txt」而文件并未创建。stdin 已关闭，无人能批准该次调用。
    args: ['-p', '{prompt}', '--output-format', 'json', '--always-approve'],
    output: 'json',
    protocol: 'grok',
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
    // **不要添加 `--auto` 或 `-y/--yolo`**：实测（2026-08-25）它直接拒绝，
    // 原文「Cannot combine --prompt with --auto」，因此每一次派发任务都以退出码 1 结束。
    //
    // 它**支持** `--output-format stream-json` 与 `-S/--session <id>`，因此存在续问的调用方式，
    // 但将这两项写入厂商表之前须先查看一次成功的输出。**本机无法采集**：其服务端对
    // 四个模型别名（kimi-for-coding / -highspeed / k3 / k3-256k）全部返回 500
    // （`APIStatusError`，它自行重试至第 10 次后放弃），流中只有 `turn.step.retrying`。
    // 已知的结构只有事件信封为 `{ role, type, … }`。**采集到输出之前不推测**：
    // 推测错误会导致表中声明支持续问、运行时却无法取得 id。
    args: ['-p', '{prompt}'],
    output: 'text',
    envKeys: ['KIMI_API_KEY'],
    credentials: ['.kimi-code/credentials/kimi-code.json'],
  },
]

export interface DetectedCli extends CliAgent {
  /** 解析得到的可执行文件绝对路径。 */
  path: string
  /** 已检测到凭证。见文件头：判定的是凭证是否存在，不是能否实际运行成功。 */
  connected: boolean
}

/**
 * 识别结果在进程内的缓存时长。识别需要在 PATH 的每个目录中逐个检查文件，在 Windows 上
 * 一次需要上千次 stat；每一轮开始都需要该清单，不缓存时每轮都要承担该开销。
 * 安装或卸载 CLI 是机器级操作，半分钟内识别不到新安装的 CLI 是可接受的边界。
 */
const DETECT_CACHE_MS = 30_000
/** 缓存按 PATH 的内容判定，不按 env 对象判定：`process.env` 始终是同一个对象，PATH 修改后也必须重新扫描。 */
let detected: { path: string; at: number; value: DetectedCli[] } | null = null

/**
 * 扫描 PATH，返回已安装的 CLI。未安装的**不出现在结果中**。
 *
 * `env` 可注入用于测试；生产环境中即为 `process.env`。
 */
export async function detectClis(env: NodeJS.ProcessEnv = process.env): Promise<DetectedCli[]> {
  const path = env.PATH ?? env.Path ?? ''
  if (detected && detected.path === path && Date.now() - detected.at < DETECT_CACHE_MS) {
    return detected.value
  }
  const value = await scanClis(env)
  detected = { path, at: Date.now(), value }
  return value
}

async function scanClis(env: NodeJS.ProcessEnv): Promise<DetectedCli[]> {
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
      ...(k.protocol ? { protocol: k.protocol } : {}),
      ...(k.resultField ? { resultField: k.resultField } : {}),
      // 遗漏复制这两项时续问会失效且不报错：厂商表中有声明，运行时却没有。
      ...(k.sessionField ? { sessionField: k.sessionField } : {}),
      ...(k.resumeArgs ? { resumeArgs: k.resumeArgs } : {}),
      // 遗漏复制该项时，实时页只有原始 JSON 行，没有 result 行时回执为空。
      ...(k.narrate ? { narrate: k.narrate } : {}),
      path,
      connected: await hasCredentials(k, home, env),
    })
  }
  return found
}

/** 按 id 取一条识别结果，供编排与工具使用。未安装或未知的 id 返回 undefined。 */
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
 * 在 PATH 上查找命令，返回绝对路径。
 *
 * **Windows 上必须自行按后缀尝试。** 同一个名称在 PATH 上通常有三个入口
 * （`x`、`x.cmd`、`x.exe`），无后缀的入口是 sh 脚本，交给 Windows 启动进程会失败；
 * 按 PATHEXT 的顺序找出实际可执行的入口，并解析为绝对路径：
 * 使用相对名称时子进程会再做一次 PATH 查找，结果可能与此处找到的不是同一个文件。
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
      if (await runnable(p)) return p
    }
    // POSIX 上不区分后缀；Windows 上无后缀的文件同样识别（可能是实际的可执行文件）。
    if (process.platform === 'win32' && (await exists(join(base, bin)))) return join(base, bin)
  }
  return null
}

/**
 * 判断路径能否作为命令执行。POSIX 上要求是带执行位的普通文件：没有执行位的文件与同名目录，
 * `execve` 以 EACCES 拒绝，shell 按 PATH 查找时跳过它们并继续向后查找。
 * Windows 没有执行位，能否执行由后缀决定，文件存在即可。
 */
async function runnable(p: string): Promise<boolean> {
  if (process.platform === 'win32') return exists(p)
  const s = await stat(p).catch(() => null)
  if (!s?.isFile()) return false
  return await access(p, constants.X_OK).then(
    () => true,
    () => false,
  )
}

async function exists(p: string): Promise<boolean> {
  return await access(p).then(
    () => true,
    () => false,
  )
}
