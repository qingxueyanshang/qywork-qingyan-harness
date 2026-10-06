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
 *
 * 其余一律放行，包括工作区内的任何读写与执行、读取工作区外的文件、启动本地服务器、
 * 安装依赖包、git push。判据是不可逆性与边界，而不是命令表面上是否危险。
 *
 * 没有允许清单，也没有「无法判定」这一结论。不要重新引入「静态允许清单 + 组合结构检测 + LLM 分类器」
 * 这一组合：
 *
 * - 允许清单（十余条只读命令）的唯一用途是省去一次分类器往返，而它带来的复杂度
 *   （参数守卫、前缀守卫、组合符号扫描、可疑码点检测）都服务于判定能否安全地跳过
 *   分类器。没有分类器，允许清单就没有存在理由。
 * - LLM 分类器不稳定：同一条命令连续运行两次给出相反结论，实测出现两次。
 *   上述三类拦截都能用确定性规则表达，不应交给概率判断。
 * - 因此 `undecided` 没有消费者。不属于上述三类的命令即放行。
 *
 * 组合命令无需单独处理。硬拒绝的模式或锚定在命令位（`CMD_POS` 匹配 `;` `&&` `|` `{` 换行之
 * 后的每一段），或扫描整个原始字符串（路径与凭证规则）。因此 `ls && rm -rf ~` 中的第二段同样被
 * 命中，无需先判定是否为单条命令。
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
 *
 * 前三条不补充，因为补充的只是又一种写法而不是这一行为本身，按写法枚举
 * 总会遗漏；第四条无法补充。实际的防线仍是沙箱，以及用户能看到每一条命令。
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
 * 会改变磁盘内容的动作。
 *
 * 用于把越界规则限定在写入与删除上，不拦截读取工作区外的文件。
 * 读取不改变任何状态，读取的实际风险（把凭证读入上下文）由凭证规则单独处理，
 * 该规则更精确：它匹配的是文件本身，与访问文件所用的命令无关。
 *
 * 读取类命令（`cat` / `type` / `Get-Content`）有意不列入。
 *
 * 每个 POSIX 命令都必须配有对应的 PowerShell 命令（`mv` ↔ `Move-Item`/`Rename-Item`、
 * `truncate` ↔ `Clear-Content`、`>` ↔ `Out-File`）：缺少一个，在没有 bash、外层为
 * PowerShell 的机器上就少一条规则，而模型在这类机器上只会使用 PowerShell 写法。
 */
const WRITE_COMMAND = String.raw`(?:Set-Content|Add-Content|Clear-Content|Out-File|New-Item|Copy-Item|Move-Item|Rename-Item|Remove-Item|\brm\b|\bmv\b|\bcp\b|\btee\b|\bdd\b|\bmkdir\b|\btouch\b|\bchmod\b|\bchown\b|\bln\b|\btruncate\b|sed\s+-i)`
const WRITE_VERB = `(?:>>?|${WRITE_COMMAND})`

/** 引号内的输出文本不构成重定向；写入与删除命令沿用同一份操作清单。 */
function hasWriteOperation(command: string): boolean {
  if (new RegExp(WRITE_COMMAND, 'i').test(command)) return true
  let nestedWrite = false
  const unquoted = command.replace(/"(?:`[\s\S]|[^"`])*"|'(?:''|[^'])*'/g, (quoted, offset) => {
    if (/(?:^|\s)-(?:c|command)\s*$/i.test(command.slice(0, offset))) {
      nestedWrite ||= hasWriteOperation(quoted.slice(1, -1))
    }
    return ''
  })
  return nestedWrite || />/.test(unquoted)
}

/**
 * 家目录与系统目录规则的标记。
 *
 * 它是 `HARD_DENY` 中唯一可以被 `additionalDirectories` 放开的规则：
 * 其余每条规则判定的都是行为本身没有正当理由（破坏磁盘、关机、提权），
 * 这些判定不会因用户多配置一个可写目录而改变。本规则判定的是位置，
 * 而位置正是额外目录所调整的维度。
 *
 * 使用显式标记而不是按索引取第 2 条：表中插入一行时，索引会静默错位，
 * 错位的结果是放开一条本应硬拒的规则。
 */
const OUTSIDE_LOCATION_RULE = 'outside-location'

/**
 * 工作区之外各位置的符号写法：写法与其在本机上的展开值。
 *
 * 同一张表承担两个用途，必须同源：它既拼入 `OUTSIDE_LOCATION`（判定命令是否涉及工作区外），又在
 * `locationCoveredByExtras` 中展开为真实路径（判定用户是否授权过该位置）。
 * 只在拒绝一侧添加写法会形成漏洞：一条同时引用 `~/data`（已授权）与
 * `$env:APPDATA`（未授权）的命令，因后者不在覆盖检查的范围内，`.every()`
 * 会判定为全部已覆盖并放行整条命令，添加规则反而放宽了规则。
 *
 * PowerShell 的几项是同一批位置的另一种写法：`$env:APPDATA` / `$env:LOCALAPPDATA` 位于家目录中
 * （`C:\Users\x\AppData\…`），`$env:windir` / `$env:SystemRoot` 即 `C:\Windows`。在没有 bash 的机
 * 器上模型只使用这些写法，不会出现 `~/` 与 `$HOME`。
 *
 * 无法取得值时返回空串：展开结果不会落入任何 extras，规则保持拒绝（fail-closed）。
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

/**
 * 指向工作区之外的位置：家目录的各种写法、`/etc`、`C:\Windows`。
 *
 * `~` 必须带分隔符，不能匹配单独的 `~`：`git diff HEAD~1` 中即包含 `~`，
 * 匹配单独的 `~` 会拒绝最常用的 git 命令之一。
 */
const OUTSIDE_LOCATION = String.raw`(?:^|[\s"'=(])~[/\\]|${OUTSIDE_SYMBOL_RE}|(?:^|[\s"'=(])\/etc\/|[A-Za-z]:[\\/]Windows[\\/]`

/*
 * 工作区中的 `.qy/` 与 `.agents/` 有意不列入本表。
 *
 * 不要添加「用 shell 写入 .qy/ 或 .agents/ 即自我提权」的规则，它因以下两条理由不成立：
 *
 * 1. 它无法限制任何能力。`.agents/mcp.json` 决定模型取得哪些工具，而模型
 *    已有 `run_command`，MCP 服务器本身就是模型能直接启动的进程。为自身添加一个
 *    工具不会获得任何新能力，只是改变了调用方式。
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

/**
 * 硬拒绝的模式。导出供文档与测试。
 *
 * 入选条件：没有任何合法的工作区用途。判据不是是否危险，而是编写代码的 agent
 * 是否不可能有正当理由。只要存在用户确实需要执行的可能，就不应列入本表；
 * 表外一律放行。
 */
export const HARD_DENY: readonly { pattern: RegExp; reason: string; id?: string }[] = [
  {
    /**
     * 命令引用家目录或系统目录，即效果必然超出工作区。
     *
     * 它必须是确定性规则。「`$HOME` 位于工作区外」是一个事实，无需每次重新判定：
     * 交给模型调用判定时，`Get-ChildItem $HOME -Recurse -Filter *.pem` 实测
     * 连续运行两次给出了相反结论。能用确定性规则表达的边界，不要交给模型推断。
     *
     * 只收录这几个位置而不收录所有绝对路径：家目录、`/etc`、`C:\Windows` 在工作区内的编码任
     * 务中没有正当用途，符合硬拒绝的入选条件。而任意绝对路径可能是用户的另一个项目目录，
     * 拒绝它的误拒代价过高，因此放行。
     *
     * `~` 必须带分隔符，只匹配 `~/` 与 `~\`：`git diff HEAD~1` 中即包含单独的 `~`，
     * 匹配单独的 `~` 会拒绝最常用的 git 命令之一。
     */
    id: OUTSIDE_LOCATION_RULE,
    pattern: new RegExp(
      String.raw`(?:${WRITE_VERB})[^\n]*(?:${OUTSIDE_LOCATION})` +
        String.raw`|(?:${OUTSIDE_LOCATION})[^\n]*\s>>?`,
      'i',
    ),
    reason:
      '该命令会在家目录或系统目录中写入或删除，效果超出工作区且不可回滚。' +
      '本机没有内核级的路径边界，此规则是唯一的约束。' +
      '确需写入工作区外的位置时，请用户将该位置加入 additionalDirectories',
  },
  {
    // rm -rf / | rm -fr /* | rm -Rf ~ | rm --recursive --force ~/
    // 目标必须是根目录或家目录本身：`rm -rf /home/x/build` 不在此列，照常放行。
    pattern: atCommandStart(
      String.raw`rm\b[^\n]*?\s-{1,2}(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r|recursive|force)[^\n]*?\s(?:\/|~)[*/]*(?=\s|$)`,
    ),
    reason: '递归删除根目录或家目录会破坏整台机器上的数据，且不可回滚',
  },
  {
    pattern: /--no-preserve-root\b/,
    reason: 'rm 仅在删除根目录被拦截时才需要此开关，出现此开关即表明意图明确',
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
    reason: '递归删除盘符根目录或家目录，等同于 rm -rf /',
  },
  {
    pattern: /\b(?:del|rd|rmdir)\b[^\n]*\s\/[sS]\b[^\n]*\s[A-Za-z]:\\[*\\]*(?=\s|$)/,
    reason: '递归删除盘符根目录（cmd 语法），等同于 rm -rf /',
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
    reason: '向 SSH 凭据写入等同于植入长期后门，此后每次登录都绕过本权限模型',
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
     * `~/.qywork/config.json` 也列入本规则：它是本程序的全局配置，明文 apiKey、权限
     * 模式、额外根目录都在该文件中。它位于家目录，写入已由工作区外写入规则拦截；本
     * 规则补充拦截读取：key 被读取的代价与私钥相同。
     *
     * 它与工作区中的 `.qy/` / `.agents/` 不同：后者是项目自身的
     * agent 配置（mcp.json、skills、team.json），修改它不构成提权（模型已有
     * `run_command`，是否添加工具不改变其能力范围），不在本规则中。
     */
    pattern:
      /(?:\.ssh[\\/]|\bid_rsa\b|\bid_ed25519\b|\bid_ecdsa\b|\.aws[\\/]credentials|\.config[\\/]gcloud[\\/]|\.kube[\\/]config|\.npmrc\b|\.netrc\b|\.pgpass\b|\.docker[\\/]config\.json|\.qywork[\\/]config\.json)/i,
    reason:
      '这是凭证文件（SSH 私钥、云厂商凭据、包管理器 token，或 qywork 自身的配置）。' +
      '读取的内容会进入上下文并发送给模型供应商，发送后无法撤回。' +
      '需要使用某个凭证时，通过环境变量传给命令，不要读取文件内容',
  },
  {
    pattern: atCommandStart(
      String.raw`(?:shutdown|reboot|halt|poweroff|Stop-Computer|Restart-Computer)\b`,
    ),
    reason: '关机/重启会中断用户正在进行的全部工作，编写代码的 agent 没有理由执行此操作',
  },
  {
    pattern: atCommandStart(String.raw`(?:sudo|doas|runas|su)\b`),
    reason: '提权执行：提权之后，工作区边界与权限检查均失去作用',
  },
  {
    pattern: /-Verb\s+RunAs\b/i,
    reason: 'Windows 上的提权（UAC 提权），与 sudo 同类',
  },
  {
    pattern: /\bchmod\b[^\n]*\b(?:777|a\+rwx)\b[^\n]*\s(?:\/|~)[*/]*(?=\s|$)/i,
    reason: '将根目录/家目录整体改为所有用户可写，系统的权限模型随即失效',
  },
  {
    pattern: /\bdd\b[^\n]*\bof=\s*\/dev\/(?!null\b|zero\b|tty\b|stdout\b|stderr\b|u?random\b)/i,
    reason: 'dd 直接写入裸设备，会整块覆盖分区表和文件系统，无法撤销',
  },
  {
    pattern: />\s*\/dev\/(?:sd[a-z]|nvme\d|hd[a-z]|disk\d|mmcblk\d)/i,
    reason: '将输出重定向到块设备，等同于擦除整块磁盘',
  },
  {
    pattern: atCommandStart(String.raw`(?:mkfs(?:\.\w+)?|diskpart|Format-Volume|Clear-Disk)\b`),
    reason: '格式化/重新分区会擦除整块磁盘上的数据',
  },
  {
    pattern: /:\(\)\s*\{[^\n]*\|[^\n]*&[^\n]*\}\s*;?\s*:/,
    reason: 'fork 炸弹会占满进程表，导致只能硬重启',
  },
]

// ───────────────────────── 裁决 ─────────────────────────

/**
 * 裁决一条 shell 命令。
 *
 * 只有拒绝清单：命中即拒绝，否则放行。没有「无法判定」这一结论，因为要判定的
 * 三类（越界写入或删除、修改系统状态、访问凭证）都是确定性的，不属于其中任何一类
 * 即说明不需要拒绝。
 */
export function decideCommand(command: string, ctx: PolicyContext): PolicyDecision {
  // 空命令没有可执行的内容。明确报告比由 shell 返回空结果更清楚。
  if (command.trim() === '') {
    return { kind: 'deny', reason: '命令为空或只有空白，没有可执行的内容' }
  }

  /*
   * 每条规则或锚定在命令位（`CMD_POS` 匹配 `;` `&&` `|` 换行之后的每一段），
   * 或扫描整个原始字符串（路径与凭证规则）。因此 `ls && rm -rf ~` 中的第二段
   * 同样被命中，无需先判定是否为单条命令：组合符号扫描的
   * 唯一用途是保护允许清单，而此处没有允许清单。
   */
  for (const rule of HARD_DENY) {
    if (!rule.pattern.test(command)) continue
    if (rule.id === OUTSIDE_LOCATION_RULE && locationCoveredByExtras(command, ctx)) continue
    return { kind: 'deny', reason: rule.reason }
  }

  // 越界位置的字面写法，与 OUTSIDE_LOCATION_RULE 共同构成同一条规则，见函数注释。
  const literal = literalOutsideHome(command, ctx)
  if (literal !== null) return { kind: 'deny', reason: literal }

  return { kind: 'allow', reason: '不属于「越界写入或删除 / 修改系统状态 / 访问凭证」三类' }
}

/**
 * 家目录的字面写法。命中时返回拒绝理由，否则返回 `null`。
 *
 * 本函数补充上述硬拒绝规则未覆盖的部分：`OUTSIDE_LOCATION_RULE` 的正则只匹配符号写法（`~/`、
 * `$HOME`、`%USERPROFILE%`、`$env:APPDATA`）。同一位置写成字面绝对路径
 * （`C:\Users\<user>\notes`）时不匹配，而 Windows 上工作区通常位于家目录中，
 * 模型写出的往往正是字面路径。
 *
 * 同一位置的两种写法不得得出两种结论。确定性规则只识别一半写法时，
 * 等同于没有该规则：只需把 `~` 展开即可绕过。
 *
 * 不要改为放宽正则：要判定的不是路径形似家目录，而是路径是否位于允许的范
 * 围内，这必须与真实的 homedir 和工作区比较。Windows 上工作区几乎总是位于家目录中
 * （`C:\Users\<user>\Desktop\proj`），因此「家目录一律拒绝」的正则会拒绝工作区本身。该判定无法用
 * 纯文本匹配实现。
 *
 * 仅裁决包含写删操作的命令。只读操作由凭证规则单独裁决。
 * 写删命令引用家目录或系统目录内、且不在工作区及额外目录内的绝对路径时拒绝。
 */
function literalOutsideHome(command: string, ctx: PolicyContext): string | null {
  if (!hasWriteOperation(command)) return null
  const home = normalizeSeparators(homedir())
  const allowed = [ctx.workspaceRoot, ...(ctx.additionalDirectories ?? [])]
    .map(normalizeSeparators)
    .filter(Boolean)

  // 必须统一大小写。Windows 与 macOS 的文件系统不区分大小写，`c:/users/x/.ssh/id_rsa`
  // 与 `C:/Users/x/.ssh/id_rsa` 是同一个文件；不统一时，把盘符写成小写即可绕过
  // 本规则，即函数注释所述的同一位置两种写法得出两种结论。
  // 本文件中 isSystem 的两条正则都带 /i，此处的字符串比较需要自行统一大小写。
  const fold = (s: string) =>
    process.platform === 'win32' || process.platform === 'darwin' ? s.toLowerCase() : s
  const inside = (p: string, root: string) => {
    const a = fold(p)
    const b = fold(root)
    return a === b || a.startsWith(`${b}/`)
  }

  for (const m of command.matchAll(/(?:^|[\s"'=(])((?:\/|[A-Za-z]:[\\/])[^\s"'`;&|)]*)/g)) {
    const p = normalizeSeparators(m[1] ?? '')
    if (!p) continue
    // 先判定允许范围：工作区本身位于家目录中，先判定允许范围才不会拒绝工作区自身。
    if (allowed.some((root) => inside(p, root))) continue

    const isHome = home !== '' && inside(p, home)
    const isSystem = /^\/etc(\/|$)/i.test(p) || /^[A-Za-z]:\/Windows(\/|$)/i.test(p)
    if (!isHome && !isSystem) continue

    return (
      `写入或删除命令引用了 ${m[1]}，该路径位于${isHome ? '家目录' : '系统目录'}中，且不在工作区内` +
      `（也不在 additionalDirectories 中），效果必然超出工作区。` +
      `本机没有内核级的路径边界，因此越界操作一律拒绝。` +
      `确需访问此目录时，请让用户将其加入 additionalDirectories。`
    )
  }
  return null
}

/**
 * 命令中每一处家目录或系统目录引用是否都位于额外根目录中。
 *
 * 必须逐处检查，不能在配置了额外目录时放行整条命令。用户把 `~/notes` 加入
 * `additionalDirectories`，含义是该目录可以访问，而不是整个家目录都可以访问。放行整条命令时，
 * `cat ~/.ssh/id_rsa` 会一并被放行，即把一项精确的授权扩大为全部授权。
 *
 * fail-closed：无法解析出具体路径（例如 `$HOME` 之后是变量而不是字面量）时，
 * 按未覆盖处理，规则照常拒绝。本规则是 deny 最终判决，没有第二层后备处理，
 * 因此无法确定时应保持拒绝，而不是放行。
 *
 * `$env:USERPROFILE` 等无法静态展开的写法：`$env:USERPROFILE\notes` 中的 `\notes` 是字面量，
 * `$env:USERPROFILE` 是展开式，判定时按本机 home 展开。这只在本机 home 与命令实际展开结果一致时成立，
 * 而这是常态。不一致的极端情况（命令在另一台机器上执行）回退为拒绝，方向安全。
 */
function locationCoveredByExtras(command: string, ctx: PolicyContext): boolean {
  const extras = (ctx.additionalDirectories ?? []).map(normalizeSeparators).filter(Boolean)
  if (extras.length === 0) return false

  const home = normalizeSeparators(homedir())

  const found = command.match(OUTSIDE_REFS)
  if (found === null || found.length === 0) return false

  return found.every((raw) => {
    const expanded = normalizeSeparators(expandOutsideRef(raw, home))
    // 展开后仍含 `$` / `%` 表示其中还有其他变量，静态分析无法确定其指向。
    if (/[$%]/.test(expanded)) return false
    return extras.some((root) => expanded === root || expanded.startsWith(`${root}/`))
  })
}

/** 路径尾部的终止符：空白、引号、反引号、shell 组合符号；其后的内容不再属于该路径。 */
const PATH_TAIL = '[^\\s"\'`;&|)]*'

/**
 * 命令中每一处工作区之外的引用，连同其后的路径尾部。
 *
 * 写法清单与 `OUTSIDE_LOCATION` 同源（见 `OUTSIDE_SYMBOLS`）：两边不一致且此处
 * 较少时，多识别一种写法反而会放宽规则。
 */
const OUTSIDE_REFS = new RegExp(
  String.raw`(?:^|(?<=[\s"'=(]))(?:~|${OUTSIDE_SYMBOL_RE}|\/etc\/|[A-Za-z]:[\\/]Windows[\\/])` +
    PATH_TAIL,
  'gi',
)

/**
 * 把一处引用的头部替换为本机上的真实路径，尾部原样保留。
 *
 * 无法取得值时（`$PROFILE`，或本机没有 `APPDATA`）保留空串或原样的
 * `$` / `%`，调用方按 fail-closed 处理：本规则是最终判决，无法确定时拒绝。
 */
function expandOutsideRef(raw: string, home: string): string {
  if (raw.startsWith('~')) return home + raw.slice(1)
  for (const sym of OUTSIDE_SYMBOLS) {
    const m = new RegExp(`^(?:${sym.re})`, 'i').exec(raw)
    if (m !== null) return sym.value() + raw.slice(m[0].length)
  }
  return raw
}

function normalizeSeparators(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}
