/**
 * run_command 的裁决层。只有拒绝清单，没有允许清单。
 *
 * 与 shell.ts 的立场一致：字符串检查无法使 shell 命令变得安全。此处只判定一件事：
 * 命令是否会造成不可逆且超出工作区的后果。不会则放行。
 *
 * 拦截范围：
 * 1. 删除或覆写工作区之外的路径（家目录、系统目录、盘符根目录）
 * 2. 修改系统状态：提权、关机、格式化、写入块设备
 * 3. 访问凭证文件：私钥、云厂商凭据、包管理器 token，以及本程序的 config.json
 * 4. 把 Python 包装入全局环境（`globalPythonInstall`）：auto 模式下包只装入工作区环境
 *
 * 其余一律放行，包括工作区内的任何读写与执行、读取工作区外的文件、启动本地服务器、
 * 装入工作区的依赖包、git push。判据是不可逆性与边界，而不是命令表面上是否危险。
 *
 * 没有允许清单，也没有「无法判定」这一结论。不要重新引入「静态允许清单 + 组合结构检测 + LLM 分类器」
 * 这一组合：
 *
 * - 允许清单（十余条只读命令）的唯一用途是省去一次分类器往返，而它带来的复杂度
 *   （参数守卫、前缀守卫、组合符号扫描、可疑码点检测）都服务于判定能否安全地跳过
 *   分类器。没有分类器，允许清单就没有存在理由。
 * - LLM 分类器不稳定：同一条命令连续运行两次给出相反结论，实测出现两次。
 *   上述四类拦截都能用确定性规则表达，不应交给概率判断。
 * - 因此 `undecided` 没有消费者。不属于上述四类的命令即放行。
 *
 * 组合命令无需单独处理。硬拒绝的模式或锚定在命令位（`CMD_POS` 匹配 `;` `&&` `|` `{` 换行之
 * 后的每一段），或扫描整个原始字符串（凭证规则）；工作区外写入规则先按组合符号切分，再逐段
 * 判定写入目标。因此 `ls && rm -rf ~` 中的第二段同样被命中。
 *
 * 同时识别两种语法，且不依据 process.platform。外层 shell 是 bash 还是 PowerShell，由本机安装的程序
 * 决定（`tools/sandbox.ts` 的 `resolveCommandShell`）。本层同时识别两种语法，以下三条理由各自独立成立：
 *
 * 1. 未安装 Git Bash 的机器上外层为 PowerShell，不会出现 POSIX 写法；
 * 2. 有 bash 的机器上，命令字符串中可以直接写 `powershell.exe -Command "Remove-Item …"`；
 * 3. 一条命令可能在一台机器上被裁决、在另一台机器上被执行。
 *
 * 已知未拦截的写法（不得视为已覆盖）：
 * - `icacls C:\ /grant Everyone:F`、`Set-Acl`：`chmod 777 /` 的 Windows 等价写法，
 *   表中只有 POSIX 写法。
 * - 写入裸设备 `\\.\PhysicalDrive0`：`dd of=/dev/sda` 的 Windows 等价写法。
 * - PowerShell 的 fork 炸弹（`while ($true) { Start-Process pwsh }`）：
 *   表中的规则只匹配 bash 的 `:(){ :|:& };:` 形式。
 * - 拼接与转义：反引号、`-join`、`Invoke-Expression $x`。把命令拆成变量再拼接后，
 *   任何静态模式都无法识别。这与 bash 中的 `$(echo rm)` 属于同一类，不在本层的覆盖范围内。
 * - 不经 pip 的全局安装：`conda install`、Python 代码中调用 `subprocess` 运行 pip。
 * - 解释器代码中的文件操作：`python -c` 的参数、交给 python 等非 shell 程序的 heredoc 正文
 *   不按 shell 语法解析。其中的 `>` 是比较运算，`.mkdir()` 是方法调用，按 shell 语法解析会误判为写入。
 *
 * 前三条与第五条不补充，因为补充的只是又一种写法而不是这一行为本身，按写法枚举
 * 总会遗漏；第四条与第六条无法补充。实际的防线仍是沙箱，以及用户能看到每一条命令。
 */

import { homedir } from 'node:os'

/** 只有两种结论。不属于拒绝清单即放行。 */
export type PolicyDecision = { kind: 'allow'; reason: string } | { kind: 'deny'; reason: string }

export interface PolicyContext {
  workspaceRoot: string
  /**
   * 工作区之外额外允许的绝对路径（配置中的 `additionalDirectories`）。
   *
   * 本层必须读取它，否则三层的结论互相矛盾：路径层已放行、内核沙箱已 bind，
   * 而静态规则仍按「家目录即越界」硬拒命令。用户配置了额外目录，
   * 得到的却是「越界一律拒绝」的错误，而该说法此时已不成立。
   */
  additionalDirectories?: readonly string[]
  /**
   * 工作区 Python 环境（`.tmp/python`，带 pip）是否存在。存在时命令中的 python 与 pip 指向它；
   * 不存在时 pip 即全局，`globalPythonInstall` 拒绝全部 pip 安装。
   */
  workspacePython?: boolean
}

// ───────────────────────── 硬拒绝 ─────────────────────────

/**
 * 命令位：字符串开头或任意组合符号之后，可跳过 sudo / env 前缀。
 *
 * 硬拒绝的模式必须锚定在命令位，否则 `git log --grep="shutdown"` 会因字符串中
 * 出现 shutdown 而被拒绝。deny 是最终判决，命中后没有后备处理，
 * 误拒的代价比漏判高一个数量级，因此锚定范围宁窄勿宽。
 *
 * `{` 也属于命令位，原因在于 Windows PowerShell 5.1：其中 `&&` 是解析错误，
 * 「上一条成功才继续」的标准写法是 `if ($?) { … }`，`run_command` 的描述也
 * 指导模型这样写。不识别 `{` 时，`if ($?) { Stop-Computer }` 会使每一条锚定在命令位
 * 的规则失配，形成由工具描述本身引出的旁路。bash 的 `{ cmd; }` 同理。
 */
const CMD_POS = String.raw`(?:^|[;&|({\n\r]|\$\()\s*(?:sudo\s+|env\s+\S+=\S+\s+)*`

const atCommandStart = (body: string): RegExp => new RegExp(CMD_POS + body, 'i')

/**
 * 工作区之外各位置的符号写法：写法与其在本机上的展开值。
 *
 * 同一张表用于展开写入目标（`expandSymbol`）与扫描命令中的工作区外引用（`OUTSIDE_REF`）。
 *
 * PowerShell 的几项是同一批位置的另一种写法：`$env:APPDATA` / `$env:LOCALAPPDATA` 位于家目录中
 * （`C:\Users\x\AppData\…`），`$env:windir` / `$env:SystemRoot` 即 `C:\Windows`。在没有 bash 的机
 * 器上模型只使用这些写法，不会出现 `~/` 与 `$HOME`。
 *
 * 无法取得值时返回空串，该位置按工作区外处理（fail-closed）。
 */
const OUTSIDE_SYMBOLS: readonly { re: string; value: () => string }[] = [
  { re: String.raw`\$\{?HOME\}?`, value: homedir },
  { re: String.raw`\$env:USERPROFILE`, value: homedir },
  { re: String.raw`\$env:HOMEPATH`, value: homedir },
  { re: '%USERPROFILE%', value: homedir },
  { re: '%HOMEPATH%', value: homedir },
  { re: String.raw`\$env:LOCALAPPDATA`, value: () => process.env.LOCALAPPDATA ?? '' },
  { re: '%LOCALAPPDATA%', value: () => process.env.LOCALAPPDATA ?? '' },
  { re: String.raw`\$env:APPDATA`, value: () => process.env.APPDATA ?? '' },
  { re: '%APPDATA%', value: () => process.env.APPDATA ?? '' },
  { re: String.raw`\$env:SystemRoot`, value: () => process.env.SystemRoot ?? '' },
  { re: '%SystemRoot%', value: () => process.env.SystemRoot ?? '' },
  { re: String.raw`\$env:windir`, value: () => process.env.windir ?? '' },
  { re: '%windir%', value: () => process.env.windir ?? '' },
  // PowerShell 的启动脚本。字面上无法看出它位于家目录中，而写入它等于此后每次启动 shell 都会执行一次。
  { re: String.raw`\$PROFILE\b`, value: () => '' },
]

const OUTSIDE_SYMBOL_RE = OUTSIDE_SYMBOLS.map((s) => s.re).join('|')

/*
 * 工作区中的 `.qy/` 与 `.agents/` 有意不列入工作区外写入规则。
 *
 * 不要添加「用 shell 写入 .qy/ 或 .agents/ 即自我提权」的规则，它因以下两条理由不成立：
 *
 * 1. 它无法限制任何能力。模型已有 `run_command`，MCP 服务器本身就是模型能直接启动的进程；
 *    写入 `.agents/mcp.json` 的服务经用户确认后才启动，启用时其命令与 `run_command` 经同一个命令判定。
 * 2. `.agents/` 本应可写：`write_memory` 向 `.agents/memory/` 写入内容。
 *    shell 拦截而工具不拦截，会对同一件事形成两套规则。
 *
 * 需要保护的是本程序的全局目录 `~/.qywork/`（明文 apiKey、权限模式、
 * 全部会话历史）。它位于家目录，写入由工作区外规则拦截，读取由凭证规则拦截，
 * 无需单独设置规则。这两个目录名称相似，但位置与含义完全不同。
 *
 * PowerShell 同样不添加：上述两条理由与外层运行的 shell 无关，
 * `Set-Content .qy\mcp.json` 与 `echo x > .qy/mcp.json` 是同一操作。
 */

/** `additionalDirectories` 在界面上的设置项。拒绝理由用它指明放开该位置的方式，不写配置字段名。 */
const EXTRA_DIRS_SETTING = '「设置 → 权限 → 工作区之外额外可读写的目录」'

/**
 * 硬拒绝的模式。导出供文档与测试。
 *
 * 入选条件：没有任何合法的工作区用途。判据不是是否危险，而是编写代码的 agent
 * 是否不可能有正当理由。只要存在用户确实需要执行的可能，就不应列入本表；
 * 表外一律放行。
 */
export const HARD_DENY: readonly { pattern: RegExp; reason: string }[] = [
  {
    // rm -rf / | rm -fr /* | rm -Rf ~ | rm --recursive --force ~/
    // 目标必须是根目录或家目录本身：`rm -rf /home/x/build` 不在此列，照常放行。
    pattern: atCommandStart(
      String.raw`rm\b[^\n]*?\s-{1,2}(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r|recursive|force)[^\n]*?\s(?:\/|~)[*/]*(?=\s|$)`,
    ),
    reason: '命令会递归删除根目录或家目录',
  },
  {
    pattern: /--no-preserve-root\b/,
    reason: '命令包含 --no-preserve-root，该开关只用于删除根目录',
  },
  {
    /*
     * `-Recurse` 用前视断言匹配，不按位置匹配：PowerShell 的命名参数与位置参数可以任意交错，
     * `Remove-Item C:\ -Recurse -Force` 与 `Remove-Item -Recurse C:\` 是同一条命令，
     * 只匹配后者时，把开关移到后面即可绕过本规则。
     *
     * 目标包含 `~`：PowerShell 支持该写法，而 `rm -rf ~` 规则只匹配 POSIX 的 `rm`。
     */
    pattern: /\bRemove-Item\b(?=[^\n]*-Recurse\b)[^\n]*\s(?:[A-Za-z]:[\\/]|~|\/)[*\\/]*(?=\s|$)/i,
    reason: '命令会递归删除盘符根目录或家目录',
  },
  {
    pattern: /\b(?:del|rd|rmdir)\b[^\n]*\s\/[sS]\b[^\n]*\s[A-Za-z]:\\[*\\]*(?=\s|$)/,
    reason: '命令会递归删除盘符根目录（cmd 语法）',
  },
  /*
   * 「下载即执行」不在本表中，不要添加。
   *
   * 针对 `curl … | sh`、`sh <(curl …)`、`iex (irm …)` 的拦截只覆盖一种写法，而不是
   * 执行来自网络的代码这一行为：`curl -o x.sh … && sh x.sh` 分两步即可绕过，
   * `npm install 任意包` 的安装脚本同样执行第三方代码。误拒则确实存在：
   * rustup、bun、deno、homebrew 的官方安装方式正是 `curl … | sh`。
   *
   * 该规则既无法拦截目标行为，又误拒真实用法，不应作为防线保留。实际的缓解手段是
   * 沙箱（限制可访问的范围）与用户能看到每一条命令，而不是模式匹配。
   */
  {
    pattern:
      /(?:>>?|\btee\b|\bcp\b|\bmv\b|\bchmod\b|\bchown\b|\bln\b|-o\b|--output\b|\bSet-Content\b|\bAdd-Content\b|\bOut-File\b|\bCopy-Item\b)[^\n]*(?:\.ssh[\\/]|\bauthorized_keys\b|\bid_rsa\b|\bid_ed25519\b)/i,
    reason: '命令会写入 SSH 密钥或 authorized_keys',
  },
  {
    /**
     * 访问凭证文件本身，读取同样拦截。
     *
     * 本规则与上一条不同：上一条处理向凭证写入，本规则处理读取凭证。
     * 读取的后果不比写入轻：内容进入上下文，随下一次请求发送给 provider，
     * 发送后无法撤回。模型也没有任何正当理由读取用户的私钥或云凭据。
     *
     * 不能只依赖脱敏：输出脱敏（`secrets.ts` 的形状规则）是第二道防线，它按 PEM 包头、`sk-`/
     * `ghp_` 等固定形状匹配，而形状无法穷举：自建服务的 token、数据库连接串中的密码、没有包头
     * 的 base64 私钥都无法识别。因此第一道防线是路径：使这些文件的内容不进入管道，比事后推测其形状
     * 可靠得多。
     *
     * 两道防线都需要：路径拦截已知位置，形状规则处理位于其他位置的凭证（例如项目中的 `.env`：
     * 它是项目文件，不应拦截读取，但其中的值不应原样进入上下文）。
     *
     * `~/.qywork/config.json` 与 `~/.qywork/mcp.json` 也列入本规则：前者是本程序的全局配置，
     * 明文 apiKey、权限模式、额外根目录都在其中；后者是全局 MCP 配置，server 的凭证写在其
     * `env` 与 `headers` 中。两者位于家目录，写入已由工作区外写入规则拦截；本规则补充拦截读取：
     * key 被读取的代价与私钥相同。
     *
     * 它与工作区中的 `.qy/` / `.agents/` 不同：后者是项目自身的
     * agent 配置（mcp.json、skills、team.json），修改它不构成提权（模型已有
     * `run_command`，是否添加工具不改变其能力范围），不在本规则中。
     */
    pattern:
      /(?:\.ssh[\\/]|\bid_rsa\b|\bid_ed25519\b|\bid_ecdsa\b|\.aws[\\/]credentials|\.config[\\/]gcloud[\\/]|\.kube[\\/]config|\.npmrc\b|\.netrc\b|\.pgpass\b|\.docker[\\/]config\.json|\.qywork[\\/](?:config|mcp)\.json)/i,
    reason:
      '命令会访问凭证文件（SSH 私钥、云服务凭据、包管理器令牌或 qywork 配置）；需要凭证时由环境变量传入命令',
  },
  {
    pattern: atCommandStart(
      String.raw`(?:shutdown|reboot|halt|poweroff|Stop-Computer|Restart-Computer)\b`,
    ),
    reason: '命令会关闭或重启计算机',
  },
  {
    pattern: atCommandStart(String.raw`(?:sudo|doas|runas|su)\b`),
    reason: '命令会以提升的权限执行（sudo、doas、runas、su）',
  },
  {
    pattern: /-Verb\s+RunAs\b/i,
    reason: '命令会以管理员权限启动进程（-Verb RunAs）',
  },
  {
    pattern: /\bchmod\b[^\n]*\b(?:777|a\+rwx)\b[^\n]*\s(?:\/|~)[*/]*(?=\s|$)/i,
    reason: '命令会将根目录或家目录改为所有用户可写',
  },
  {
    pattern: /\bdd\b[^\n]*\bof=\s*\/dev\/(?!null\b|zero\b|tty\b|stdout\b|stderr\b|u?random\b)/i,
    reason: '命令会用 dd 写入块设备',
  },
  {
    pattern: />\s*\/dev\/(?:sd[a-z]|nvme\d|hd[a-z]|disk\d|mmcblk\d)/i,
    reason: '命令会将输出重定向到块设备',
  },
  {
    pattern: atCommandStart(String.raw`(?:mkfs(?:\.\w+)?|diskpart|Format-Volume|Clear-Disk)\b`),
    reason: '命令会格式化磁盘或重新分区',
  },
  {
    pattern: /:\(\)\s*\{[^\n]*\|[^\n]*&[^\n]*\}\s*;?\s*:/,
    reason: '命令是 fork 炸弹，会无限创建进程',
  },
]

// ───────────────────────── 裁决 ─────────────────────────

/**
 * 裁决一条 shell 命令。
 *
 * 只有拒绝清单：命中即拒绝，否则放行。没有「无法判定」这一结论，因为要判定的
 * 四类（越界写入或删除、修改系统状态、访问凭证、全局安装 Python 包）都是确定性的，不属于其中任何一类
 * 即说明不需要拒绝。
 */
export function decideCommand(command: string, ctx: PolicyContext): PolicyDecision {
  // 空命令没有可执行的内容。明确报告比由 shell 返回空结果更清楚。
  if (command.trim() === '') {
    return { kind: 'deny', reason: '命令为空或只有空白，没有可执行的内容' }
  }

  /*
   * 每条规则或锚定在命令位（`CMD_POS` 匹配 `;` `&&` `|` 换行之后的每一段），
   * 或扫描整个原始字符串（凭证规则）。因此 `ls && rm -rf ~` 中的第二段
   * 同样被命中，无需先判定是否为单条命令：组合符号扫描的
   * 唯一用途是保护允许清单，而此处没有允许清单。
   */
  for (const rule of HARD_DENY) {
    if (rule.pattern.test(command)) return { kind: 'deny', reason: rule.reason }
  }

  const outside = outsideWrite(command, ctx)
  if (outside !== null) return { kind: 'deny', reason: outside }

  const install = globalPythonInstall(command, ctx)
  if (install !== null) return { kind: 'deny', reason: install }

  return {
    kind: 'allow',
    reason: '不属于「越界写入或删除 / 修改系统状态 / 访问凭证 / 全局安装 Python 包」四类',
  }
}

/** pip 安装命令：`pip install`、`pip3 install`、`python -m pip install`、`uv pip install`。 */
const PIP_INSTALL = /(?:\bpip(?:\d+(?:\.\d+)?)?(?:\.exe)?["']?|\s-m\s+pip)\s+install\b/i

/** 解释器或 pip 的路径（可带引号）紧接安装子命令：`"C:\Python312\python.exe" -m pip install`。 */
const INTERPRETER_INSTALL =
  /(?:"([^"\n]+)"|'([^'\n]+)'|((?:[A-Za-z]:[\\/]|\/)[^\s"'`;&|)]+))\s+(?:-m\s+pip\s+)?install\b/gi

/** 指定安装位置的参数与其路径。 */
const INSTALL_LOCATION =
  /(?:^|\s)(?:--target|--prefix|--root|-t)(?:\s+|=)(?:"([^"\n]+)"|'([^'\n]+)'|([^\s"'`;&|)]+))/gi

/**
 * auto 模式下把 Python 包装入全局环境。命中时返回拒绝理由，否则返回 `null`。
 *
 * 工作区环境存在时，命令中的 python 与 pip 指向它（tools `commandEnv`），只有以下写法越过它：
 * `--user`、`uv pip install --system`、Windows 的 `py` 启动器、工作区外的解释器或 pip 路径、
 * `--target` / `--prefix` / `--root` 指向工作区外。工作区环境不存在时 pip 即全局，安装一律拒绝。
 */
function globalPythonInstall(command: string, ctx: PolicyContext): string | null {
  if (!PIP_INSTALL.test(command)) return null
  const deny = (how: string) =>
    `${how}，会安装到全局 Python 环境；包只能安装到工作区环境 .tmp/python，` +
    '命令中的 python 与 pip 即指向该环境'
  if (!ctx.workspacePython) return deny('工作区 Python 环境不存在，命令中的 pip 属于全局环境')
  if (/(?:^|\s)--user\b/i.test(command)) return deny('--user 安装到用户目录')
  if (/\buv\s+pip\s+install\b[^\n]*\s--system\b/i.test(command))
    return deny('uv pip install --system')
  if (
    atCommandStart(String.raw`(?:&\s*)?py(?:\.exe)?(?:\s+-[\w.]+)*\s+-m\s+pip\s+install\b`).test(
      command,
    )
  )
    return deny('py 启动器调用全局解释器')
  for (const m of command.matchAll(INTERPRETER_INSTALL)) {
    const p = m[1] ?? m[2] ?? m[3] ?? ''
    if (!/(?:^|[\\/])(?:python|pip)[\d.]*(?:\.exe)?$/i.test(p)) continue
    if (/^(?:[A-Za-z]:[\\/]|\/)/.test(p) && !withinAllowed(p, ctx))
      return deny(`${p} 是工作区外的解释器`)
  }
  for (const m of command.matchAll(INSTALL_LOCATION)) {
    const p = m[1] ?? m[2] ?? m[3] ?? ''
    if (/^(?:[A-Za-z]:[\\/]|\/|~)/.test(p) && !withinAllowed(p, ctx))
      return deny(`安装位置 ${p} 在工作区外`)
  }
  return null
}

/** 路径是否位于工作区或额外目录内。 */
function withinAllowed(path: string, ctx: PolicyContext): boolean {
  const p = normalizeSeparators(path.startsWith('~') ? homedir() + path.slice(1) : path)
  return [ctx.workspaceRoot, ...(ctx.additionalDirectories ?? [])]
    .map(normalizeSeparators)
    .filter(Boolean)
    .some((root) => inside(p, root))
}

/**
 * Windows 与 macOS 的文件系统不区分大小写，`c:/users/x/.ssh/id_rsa` 与 `C:/Users/x/.ssh/id_rsa` 是同一个文件；
 * 不统一时，把盘符写成小写即可绕过路径规则。
 */
function fold(s: string): string {
  return process.platform === 'win32' || process.platform === 'darwin' ? s.toLowerCase() : s
}

/** `p` 是否为 `root` 本身或位于其下。两者均已统一分隔符。 */
function inside(p: string, root: string): boolean {
  const a = fold(p)
  const b = fold(root)
  return a === b || a.startsWith(`${b}/`)
}

// ───────────────────────── 工作区外的写入与删除 ─────────────────────────

/**
 * 写入或删除磁盘内容的命令，值为写入目标的取法：
 * - `all`：全部非选项参数；
 * - `dest`：`-t` / `--target-directory` / `-Destination` 的值，否则为最后一个非选项参数。
 *   其余参数是读取来源：从工作区外复制到工作区内只读取工作区外的文件；
 * - `of`：`dd` 的 `of=` 值。
 *
 * 读取类命令（`cat` / `type` / `Get-Content`）有意不列入：读取不改变任何状态，
 * 读取的实际风险（把凭证读入上下文）由凭证规则按文件本身判定。
 *
 * 每个 POSIX 命令都必须配有对应的 PowerShell 命令（`mv` ↔ `Move-Item`/`Rename-Item`、
 * `truncate` ↔ `Clear-Content`、`>` ↔ `Out-File`）：缺少一个，在没有 bash、外层为
 * PowerShell 的机器上就少一条规则，而模型在这类机器上只会使用 PowerShell 写法。
 */
const WRITE_COMMANDS = new Map<string, 'all' | 'dest' | 'of'>([
  ['rm', 'all'],
  ['mv', 'all'],
  ['tee', 'all'],
  ['mkdir', 'all'],
  ['touch', 'all'],
  ['chmod', 'all'],
  ['chown', 'all'],
  ['truncate', 'all'],
  ['sed', 'all'],
  ['set-content', 'all'],
  ['add-content', 'all'],
  ['clear-content', 'all'],
  ['out-file', 'all'],
  ['new-item', 'all'],
  ['move-item', 'all'],
  ['rename-item', 'all'],
  ['remove-item', 'all'],
  ['cp', 'dest'],
  ['ln', 'dest'],
  ['copy-item', 'dest'],
  ['dd', 'of'],
])

/** 在参数中执行另一条命令的程序。其后出现的写入命令，目标无法按参数位置确定。 */
const RUNNERS = new Set([
  'env',
  'nohup',
  'time',
  'nice',
  'timeout',
  'command',
  'exec',
  'xargs',
  'busybox',
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
])

/** 位于命令名之前的 bash 关键字：`for f in …; do rm "$f"; done` 中该段的命令是 `rm`。 */
const SHELL_KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!'])

/** 切换当前目录的命令。切换到工作区外之后，相对路径的写入目标同样位于工作区外。 */
const CHANGE_DIR = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location'])

/**
 * 解释 shell 语法的程序。只有它们的 `-c` / `-Command` 参数与 heredoc 正文按命令解析；
 * 交给 python 等其他程序的代码是数据，见文件头「已知未拦截的写法」。
 */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'pwsh', 'powershell'])

/** 组合符号之间的一条简单命令。 */
interface Segment {
  words: string[]
  /** `>` / `>>` 的目标。`2>&1` 这类文件描述符复制没有目标。 */
  redirects: string[]
  /** 交给本段命令的 heredoc 正文。 */
  heredocs: string[]
  /** 双引号内 `$( )` 中的命令。 */
  substitutions: string[]
  /** 本段在 `(` 处结束：其后的参数是子表达式的结果，无法从命令文本确定。 */
  opensExpr: boolean
}

interface PendingHeredoc {
  seg: Segment
  delim: string
  strip: boolean
}

type Place = 'allowed' | 'outside' | 'unknown'

interface Located {
  place: Place
  /** 拒绝理由中显示的路径：相对路径前加上工作区外的当前目录。 */
  shown: string
}

/**
 * 工作区外的写入或删除。命中时返回拒绝理由，否则返回 `null`。
 *
 * 判定的是写入目标，不是命令中出现的路径：`cp <家目录中的附件> docs/` 只读取工作区外的文件。
 * 不要改为「命令含写入动作且引用工作区外路径即拒绝」：`python -c` 代码中的 `.mkdir()`、
 * `2>/dev/null`、复制来源都会使只读取工作区外文件的命令被拒绝，而同一操作换一种写法即可执行。
 *
 * 写入目标无法从命令文本确定（变量、管道输入、子表达式、`xargs` 等之后的写入命令）时，
 * 命令中出现任一工作区外引用即拒绝（fail-closed）。
 *
 * 必须是确定性规则：交给模型判定时，`Get-ChildItem $HOME -Recurse -Filter *.pem` 实测连续运行两次
 * 给出了相反结论。只判定家目录、`/etc`、`C:\Windows`，不判定所有绝对路径：其他绝对路径可能是
 * 用户的另一个项目目录，误拒代价过高。
 */
function outsideWrite(command: string, ctx: PolicyContext): string | null {
  let cwd: Located = { place: 'allowed', shown: '' }
  let indeterminate = false
  for (const seg of segments(command)) {
    // 跳过命令名之前的环境变量赋值（`FOO=1 rm …`）与关键字。
    let k = 0
    while (k < seg.words.length) {
      const w = seg.words[k] as string
      if (!/^[A-Za-z_]\w*=/.test(w) && !SHELL_KEYWORDS.has(w)) break
      k++
    }
    const name = commandName(seg.words[k] ?? '')
    const args = seg.words.slice(k + 1)

    if (CHANGE_DIR.has(name)) {
      const target = args.length === 0 ? '~' : args.find((a) => !a.startsWith('-'))
      if (target !== undefined) cwd = locate(target, ctx, cwd)
      continue
    }

    const mode = WRITE_COMMANDS.get(name)
    const inPlace = name !== 'sed' || args.some((a) => /^-(?:[a-zA-Z]*i|-in-place)/.test(a))
    const targets = mode !== undefined && inPlace ? pick(mode, args) : null
    // PowerShell 命令没有路径参数时，写入目标来自管道输入。
    if (targets !== null && (seg.opensExpr || (targets.length === 0 && name.includes('-')))) {
      indeterminate = true
    }
    const runner = seg.words.findIndex((w, j) => j >= k && RUNNERS.has(commandName(w)))
    if (
      runner !== -1 &&
      seg.words.slice(runner + 1).some((w) => WRITE_COMMANDS.has(commandName(w)))
    ) {
      indeterminate = true
    }

    for (const t of [...seg.redirects, ...(targets ?? [])]) {
      const at = locate(t, ctx, cwd)
      if (at.place === 'outside') {
        return `写入目标 ${at.shown} 位于工作区之外，且未列入${EXTRA_DIRS_SETTING}`
      }
      if (at.place === 'unknown') indeterminate = true
    }

    const scripts = SHELLS.has(name) ? [...seg.heredocs, ...inlineScript(name, args)] : []
    for (const inner of [...seg.substitutions, ...scripts]) {
      const reason = outsideWrite(inner, ctx)
      if (reason !== null) return reason
    }
  }
  if (!indeterminate) return null
  for (const m of command.matchAll(OUTSIDE_REF)) {
    if (classify(m[0], ctx) === 'outside') {
      return `命令引用了工作区之外的 ${m[0]}，且写入目标无法从命令文本确定`
    }
  }
  return null
}

/**
 * 把命令切分为段。识别引号、文件描述符复制、heredoc 与行尾的换行转义，不展开变量。
 *
 * 反斜杠不作为转义符：PowerShell 路径以反斜杠分隔，按 bash 规则去除反斜杠时
 * `C:\Users\x` 变为 `C:Usersx`，不再被识别为家目录。
 */
function segments(command: string): Segment[] {
  const out: Segment[] = []
  const fresh = (): Segment => ({
    words: [],
    redirects: [],
    heredocs: [],
    substitutions: [],
    opensExpr: false,
  })
  const pending: PendingHeredoc[] = []
  let seg = fresh()
  let word = ''
  let inWord = false
  // 下一个词的用途：命令参数、重定向目标，或 `<` 的输入来源（不是写入目标）。
  let role: 'word' | 'redirect' | 'input' = 'word'

  const endWord = () => {
    if (!inWord) return
    if (role === 'word') seg.words.push(word)
    else if (role === 'redirect') seg.redirects.push(word)
    role = 'word'
    word = ''
    inWord = false
  }
  const endSegment = (opensExpr: boolean) => {
    endWord()
    role = 'word'
    seg.opensExpr = opensExpr
    if (seg.words.length + seg.redirects.length + seg.substitutions.length > 0) out.push(seg)
    seg = fresh()
  }

  let i = 0
  while (i < command.length) {
    const c = command[i] as string
    const next = command[i + 1]
    if (
      (c === '\\' || c === '`') &&
      (next === '\n' || (next === '\r' && command[i + 2] === '\n'))
    ) {
      i += next === '\n' ? 2 : 3
    } else if (c === "'") {
      const end = command.indexOf("'", i + 1)
      const stop = end === -1 ? command.length : end
      word += command.slice(i + 1, stop)
      inWord = true
      i = stop + 1
    } else if (c === '"') {
      let j = i + 1
      while (j < command.length && command[j] !== '"') {
        if (command[j] === '$' && command[j + 1] === '(') {
          const end = closingParen(command, j + 1)
          seg.substitutions.push(command.slice(j + 2, end))
          j = end + 1
        } else {
          j += command[j] === '\\' || command[j] === '`' ? 2 : 1
        }
      }
      word += command.slice(i + 1, j)
      inWord = true
      i = j + 1
    } else if (c === '$' && next === '{') {
      const end = command.indexOf('}', i)
      const stop = end === -1 ? command.length : end + 1
      word += command.slice(i, stop)
      inWord = true
      i = stop
    } else if (c === '{' && next === '}') {
      // `find -exec` 与 `xargs -I` 的占位符，不是语句块。
      word += '{}'
      inWord = true
      i += 2
    } else if (c === '\n') {
      endSegment(false)
      i = readHeredocs(command, i + 1, pending)
    } else if (';&|(){}\r`'.includes(c)) {
      endSegment(c === '(')
      i++
    } else if (c === '>') {
      // `2>`、`*>` 中的数字与星号是文件描述符，不是参数。
      if (/^(?:\d+|\*)$/.test(word)) {
        word = ''
        inWord = false
      }
      endWord()
      i++
      if (command[i] === '>' || command[i] === '|') i++
      if (command[i] === '&' && /[\d-]/.test(command[i + 1] ?? '')) {
        // `2>&1`、`>&-`：复制或关闭文件描述符，没有写入目标。
        i++
        while (/[\d-]/.test(command[i] ?? '')) i++
      } else {
        if (command[i] === '&') i++
        role = 'redirect'
      }
    } else if (c === '<') {
      endWord()
      const heredoc = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([^\s;&|<>()]+))/.exec(
        command.slice(i),
      )
      if (heredoc !== null && command[i + 2] !== '<') {
        pending.push({
          seg,
          delim: heredoc[2] ?? heredoc[3] ?? heredoc[4] ?? '',
          strip: heredoc[1] === '-',
        })
        i += heredoc[0].length
      } else {
        while (command[i] === '<') i++
        role = 'input'
      }
    } else if (c === ' ' || c === '\t') {
      endWord()
      i++
    } else {
      word += c
      inWord = true
      i++
    }
  }
  endSegment(false)
  return out
}

/** 从 `start` 起依次读取各 heredoc 的正文，直到各自的结束行。返回正文之后的下标。 */
function readHeredocs(command: string, start: number, pending: PendingHeredoc[]): number {
  let i = start
  for (const p of pending.splice(0)) {
    const body: string[] = []
    while (i < command.length) {
      const nl = command.indexOf('\n', i)
      const end = nl === -1 ? command.length : nl
      const line = command.slice(i, end).replace(/\r$/, '')
      i = end + 1
      if ((p.strip ? line.replace(/^\t+/, '') : line) === p.delim) break
      body.push(line)
    }
    p.seg.heredocs.push(body.join('\n'))
  }
  return i
}

/** `s[open]` 为 `(`，返回与之匹配的 `)` 的下标；单引号内的括号不计。未闭合时返回 `s.length`。 */
function closingParen(s: string, open: number): number {
  let depth = 0
  for (let j = open; j < s.length; j++) {
    const c = s[j]
    if (c === "'") {
      const end = s.indexOf("'", j + 1)
      if (end === -1) return s.length
      j = end
    } else if (c === '(') {
      depth++
    } else if (c === ')') {
      depth--
      if (depth === 0) return j
    }
  }
  return s.length
}

/** 命令名：去掉目录与 `.exe` 后转为小写。PowerShell 命令不区分大小写。 */
function commandName(word: string): string {
  return word
    .replace(/^.*[\\/]/, '')
    .replace(/\.exe$/i, '')
    .toLowerCase()
}

/** 按 `WRITE_COMMANDS` 的取法从参数中取出写入目标。 */
function pick(mode: 'all' | 'dest' | 'of', args: readonly string[]): string[] {
  if (mode === 'of') return args.filter((a) => a.startsWith('of=')).map((a) => a.slice(3))
  const positional = args.filter((a) => !a.startsWith('-'))
  if (mode === 'all') return positional
  for (const [j, a] of args.entries()) {
    if (a.startsWith('--target-directory=')) return [a.slice('--target-directory='.length)]
    const flag = a.toLowerCase()
    // PowerShell 参数名可以写为任意无歧义的前缀。
    if (
      flag === '-t' ||
      flag === '--target-directory' ||
      (flag.length >= 4 && '-destination'.startsWith(flag))
    ) {
      return args.slice(j + 1, j + 2)
    }
  }
  return positional.slice(-1)
}

/**
 * shell 的内联脚本：bash 的 `-c`（可与其他单字母选项合写，如 `-lc`），PowerShell 的 `-Command`
 * 及其前缀缩写。PowerShell 把 `-Command` 之后的全部参数作为命令，因此拼接其后全部参数。
 *
 * 不要对 PowerShell 使用 bash 的判据：`-Exec`（`-ExecutionPolicy` 的缩写）以 `c` 结尾，
 * 会被当作 `-c`，真正的 `-Command` 脚本因此不被解析。
 */
function inlineScript(name: string, args: readonly string[]): string[] {
  const powershell = name === 'pwsh' || name === 'powershell'
  const at = args.findIndex((a) => {
    const flag = a.toLowerCase()
    return powershell
      ? flag.length >= 2 && '-command'.startsWith(flag)
      : /^-[a-z]*c[a-z]*$/.test(flag)
  })
  return at === -1 ? [] : [args.slice(at + 1).join(' ')]
}

/** 写入目标的位置。相对路径按当前目录判定：`cd` 到工作区外之后，`rm -rf build` 删除的是工作区外的内容。 */
function locate(word: string, ctx: PolicyContext, cwd: Located): Located {
  const place = classify(word, ctx)
  if (
    place === 'allowed' &&
    cwd.place !== 'allowed' &&
    !/^(?:[\\/]|[A-Za-z]:[\\/]|~|\$|%)/.test(word)
  ) {
    return { place: cwd.place, shown: `${cwd.shown}/${word}` }
  }
  return { place, shown: word }
}

/**
 * 判定一个路径的位置。
 * - `allowed`：工作区、额外目录、相对路径，以及家目录与系统目录之外的绝对路径；
 * - `outside`：家目录或系统目录中、且不在工作区与额外目录内；
 * - `unknown`：以变量开头，无法从命令文本确定。
 *
 * 路径中段出现变量时按变量之前的字面前缀判定：`$HOME/$X/out` 的前缀是家目录本身，
 * 位于额外目录 `~/data` 之外，按工作区外处理。
 */
function classify(word: string, ctx: PolicyContext): Place {
  if (/^\$null$/i.test(word)) return 'allowed'
  const expanded = expandSymbol(word)
  if (expanded === '') return 'outside'
  let path = normalizeSeparators(expanded ?? word)
  const cut = path.search(/\$|%\w+%/)
  if (cut === 0) return 'unknown'
  if (cut > 0) path = path.slice(0, cut)
  if (!/^(?:\/|[A-Za-z]:\/)/.test(path)) return 'allowed'
  // 先判定允许范围：Windows 上工作区通常位于家目录中。
  if (withinAllowed(path, ctx)) return 'allowed'
  const home = normalizeSeparators(homedir())
  const isHome = home !== '' && inside(path, home)
  const isSystem = /^\/etc(?:\/|$)/i.test(path) || /^[A-Za-z]:\/Windows(?:\/|$)/i.test(path)
  return isHome || isSystem ? 'outside' : 'allowed'
}

/** 把开头的家目录或系统目录符号展开为本机路径。没有符号时返回 `null`，符号在本机没有值时返回空串。 */
function expandSymbol(word: string): string | null {
  if (/^~(?:[\\/]|$)/.test(word)) {
    const home = homedir()
    return home === '' ? '' : home + word.slice(1)
  }
  for (const sym of OUTSIDE_SYMBOLS) {
    const m = new RegExp(`^(?:${sym.re})(?!\\w)`, 'i').exec(word)
    if (m === null) continue
    const value = sym.value()
    return value === '' ? '' : value + word.slice(m[0].length)
  }
  return null
}

/**
 * 命令文本中可能位于工作区外的引用：`~`、各符号写法与绝对路径，连同其后的路径尾部。
 * `~` 必须单独成词或后接分隔符：`git diff HEAD~1` 中的 `~` 不是家目录。
 */
const OUTSIDE_REF = new RegExp(
  String.raw`(?<=^|[\s"'=(,])(?:~(?=[\\/\s"',)]|$)|${OUTSIDE_SYMBOL_RE}|\/|[A-Za-z]:[\\/])` +
    '[^\\s"\'`;&|),]*',
  'gi',
)

function normalizeSeparators(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}
