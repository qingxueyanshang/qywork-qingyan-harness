/**
 * run_command 的裁决层。**只有拒绝清单，没有允许清单。**
 *
 * 立场承自 shell.ts：不假装能靠字符串检查把 shell 命令变安全。这里只回答一个问题
 * ——**这条命令会不会造成「不可逆且越出工作区」的后果**。答案是否，就放行。
 *
 * ## 拦什么
 *
 * 1. **删除 / 覆写工作区之外的东西**（家目录、系统目录、盘符根）
 * 2. **改系统状态**：提权、关机、格式化、写块设备
 * 3. **碰凭证文件**：私钥、云厂商凭据、包管理器 token，以及本程序自己的 config.json
 *
 * 其余一律放行——包括工作区内的任何读写与执行、**读**工作区外的文件、起本地服务器、
 * 装包、git push。判据是**不可逆性与边界**，不是「这条命令看起来危不危险」。
 *
 * ## 为什么没有允许清单，也没有「判不了」这一档
 *
 * 别把「静态允许清单 + 组合结构检测 + LLM 分类器」这套加回来：
 *
 * - **允许清单**（十几条只读命令）只为省一次分类器往返而存在，而它带来的复杂度
 *   （参数守卫、前缀守卫、组合符号扫描、可疑码点检测）全是为「能不能安全地跳过
 *   分类器」服务的。没有分类器就没有它的理由。
 * - **LLM 分类器**不稳定：同一条命令连跑两次给出相反结论，实测两次。
 *   而上面三类拦截**全部能用确定性规则表达**，不该交给概率。
 * - **`undecided`** 于是没有消费者。判不出它属于那三类，就说明它不属于，放行。
 *
 * ## 组合命令不需要单独处理
 *
 * 硬拒绝的模式要么锚在**命令位**（`CMD_POS` 认 `;` `&&` `|` 换行之后的每一段），
 * 要么扫**整个原始串**（路径、凭证那几条）。所以 `ls && rm -rf ~` 里的第二段照样
 * 被抓到，不必先判「这是不是单条命令」。
 *
 * 本项目只跑 `bash -c`（Windows 上是 Git for Windows 自带的那个，
 * 见 `tools/sandbox.ts` 的 `commandShell()`），没有第二种 shell。
 * **PowerShell 语法的模式仍然留在表里**：命令串里随时可以写
 * `powershell.exe -Command "Remove-Item ..."`，那条路和外层 shell 是什么无关。
 * 判断时不看 process.platform：一条命令完全可能在一台机器上被裁决、
 * 在另一台上被执行。
 */

import { homedir } from 'node:os'

/** 只有两种结论。判不出属于拒绝清单，就是放行。 */
export type PolicyDecision = { kind: 'allow'; reason: string } | { kind: 'deny'; reason: string }

export interface PolicyContext {
  workspaceRoot: string
  /**
   * 工作区之外额外允许的绝对路径（配置里的 `additionalDirectories`）。
   *
   * **这一层必须知道它，否则三层会打架。** 路径层放行了、内核沙箱 bind 了，
   * 而静态规则这里仍然按「家目录 = 越界」把命令硬拒——用户配了额外目录，
   * 得到的是一条说「越界一律拒绝」的错误，而那句话此刻已经不成立。
   *
   * 见 ROADMAP §31 的三层表。
   */
  additionalDirectories?: readonly string[]
}

// ───────────────────────── 硬拒绝 ─────────────────────────

/**
 * 命令位：串首，或任意组合符号之后，允许跳过 sudo / env 前缀。
 *
 * 硬拒绝的模式必须锚在命令位上，否则 `git log --grep="shutdown"` 会因为字符串里
 * 出现了 shutdown 就被拒。deny 是终局判决，没有分类器兜底，它的误伤代价比 undecided
 * 高一个数量级——宁可锚窄。
 */
const CMD_POS = String.raw`(?:^|[;&|(\n\r]|\$\()\s*(?:sudo\s+|env\s+\S+=\S+\s+)*`

const atCommandStart = (body: string): RegExp => new RegExp(CMD_POS + body, 'i')

/**
 * 会**改变磁盘**的动作。
 *
 * 用来把「越界」这条规则限定在写和删上——**读工作区外的文件不拦**。
 * 读不改变任何东西，而它的真实风险（把凭证读进上下文）由凭证那条规则单独管，
 * 那条更准：它盯的是文件本身，不管你用什么动词去碰它。
 *
 * 读类动词（`cat` / `type` / `Get-Content`）刻意不在其中。
 */
const WRITE_VERB = String.raw`(?:>>?|Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|Remove-Item|\brm\b|\bmv\b|\bcp\b|\btee\b|\bdd\b|\bmkdir\b|\btouch\b|\bchmod\b|\bchown\b|\bln\b|\btruncate\b|sed\s+-i)`

/**
 * 家目录/系统目录那条规则的标记。
 *
 * 它是 `HARD_DENY` 里**唯一**一条可以被 `additionalDirectories` 放开的：
 * 其余每一条判的都是「这件事本身没有正当理由」（毁盘、下载即执行、提权），
 * 而那些理由不会因为用户多配了一个可写目录就改变。这一条判的是**位置**，
 * 而位置正是额外目录要改的东西。
 *
 * 用一个显式标记而不是「按索引第 2 条」：后者在有人往表里插一行时会静默错位，
 * 而错位的方向是**放开一条本该硬拒的规则**。
 */
const OUTSIDE_LOCATION_RULE = 'outside-location'

/**
 * 指向工作区之外的位置：家目录的各种写法、`/etc`、`C:\Windows`。
 *
 * `~` 必须带分隔符。裸 `~` 不行——`git diff HEAD~1` 里就有一个，
 * 这条差点写错，而写错的后果是把最常用的 git 命令之一拒掉。
 */
const OUTSIDE_LOCATION = String.raw`(?:^|[\s"'=(])~[/\\]|\$\{?HOME\}?|\$env:USERPROFILE|\$env:HOMEPATH|%USERPROFILE%|%HOMEPATH%|(?:^|[\s"'=(])\/etc\/|[A-Za-z]:[\\/]Windows[\\/]`

/*
 * **工作区里的 `.qy/` 与 `.agents/` 不在这张表里，这是有意的。**
 *
 * 别加「用 shell 写 .qy/ 或 .agents/ = 自我提权」这条。两条理由让它站不住：
 *
 * 1. **它拦不到任何能力。** `.agents/mcp.json` 决定模型拿到哪些工具，可模型手里
 *    已经有 `run_command`——MCP 服务器本身就是个它能直接启动的进程。给自己加一个
 *    工具，没有获得任何它现在没有的能力，只是换了个调用方式。
 * 2. **`.agents/` 本来就该写。** `memory` 工具正往 `.agents/memory/` 里写。
 *    shell 拦、工具不拦，就是同一件事两套账。
 *
 * 真正需要保护的是**本程序自己的**全局目录 `~/.qywork/`（明文 apiKey、权限模式、
 * 全部会话历史）——而它躺在家目录，写由「工作区外」那条挡、读由凭证那条挡，
 * 不需要单开一条。这两个东西名字像，位置和含义完全不同。
 */

/**
 * 硬拒绝的模式。导出供文档与测试。
 *
 * 入选门槛：**没有任何合法的工作区用途**。不是「危险」，是「在一个写代码的 agent
 * 手里不可能有正当理由」。凡是能想出「万一用户真要这么干」的，都不该进这张表——
 * 它们该落 undecided，让分类器结合上下文判。
 */
export const HARD_DENY: readonly { pattern: RegExp; reason: string; id?: string }[] = [
  {
    /**
     * 命令里引用了家目录或系统目录 = 效果一定越出工作区。
     *
     * ## 为什么这条要放进确定性规则，而不是交给分类器
     *
     * 实测抓到的：`Get-ChildItem $HOME -Recurse -Filter *.pem` **同一条命令
     * 两次跑出了两个不同结论**——一次拦一次放。分类器是概率判断，
     * 而「`$HOME` 在工作区外」是一个**事实**，不该每次重新赌一遍。
     *
     * 这和 `.qy/` 那条是同一类错误：我把不该交给概率的知识交给了概率。
     * 凡是能用确定性规则表达的边界，就不要留给模型推。
     *
     * ## 为什么只收这几个，不收所有绝对路径
     *
     * 家目录、`/etc`、`C:\Windows` 在一个工作区内的编码任务里**没有正当用途**，
     * 符合硬拒绝的入选门槛。而一个随便的绝对路径可能是用户的另一个项目目录，
     * 那种要结合上下文判——留给分类器。
     *
     * ## `~` 必须带分隔符
     *
     * 裸 `~` 不行：`git diff HEAD~1` 里就有一个。只认 `~/` 和 `~\`。
     * 这条差点写错，而写错的后果是把最常用的 git 命令之一拒掉。
     */
    id: OUTSIDE_LOCATION_RULE,
    pattern: new RegExp(
      String.raw`(?:${WRITE_VERB})[^\n]*(?:${OUTSIDE_LOCATION})` +
        String.raw`|(?:${OUTSIDE_LOCATION})[^\n]*\s>>?`,
      'i',
    ),
    reason:
      '命令要往家目录或系统目录里写/删，效果越出工作区且不可回滚。' +
      '这台机器上没有内核级的路径边界，规则本身就是唯一的约束——' +
      '确实需要写工作区外的位置，请用户把它加进 additionalDirectories',
  },
  {
    // rm -rf / | rm -fr /* | rm -Rf ~ | rm --recursive --force ~/
    // 目标必须是根或家目录本身：`rm -rf /home/x/build` 不在此列，那是分类器的活。
    pattern: atCommandStart(
      String.raw`rm\b[^\n]*?\s-{1,2}(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r|recursive|force)[^\n]*?\s(?:\/|~)[*/]*(?=\s|$)`,
    ),
    reason: '递归删除根目录或家目录，会毁掉整台机器上的数据，且不可回滚',
  },
  {
    pattern: /--no-preserve-root\b/,
    reason: 'rm 只有在删根目录被拦下时才需要这个开关，它出现即意图明确',
  },
  {
    pattern: /\bRemove-Item\b[^\n]*-Recurse\b[^\n]*\s(?:[A-Za-z]:[\\/]|\/)[*\\/]*(?=\s|$)/i,
    reason: '递归删除盘符根目录，与 rm -rf / 是同一件事',
  },
  {
    pattern: /\b(?:del|rd|rmdir)\b[^\n]*\s\/[sS]\b[^\n]*\s[A-Za-z]:\\[*\\]*(?=\s|$)/,
    reason: '递归删除盘符根目录（cmd 语法），与 rm -rf / 是同一件事',
  },
  /*
   * **「下载即执行」不在这张表里，别再加回来。**
   *
   * 盯 `curl … | sh`、`sh <(curl …)`、`iex (irm …)` 拦的是**一种写法**，不是
   * 「执行来自网络的代码」这件事：`curl -o x.sh … && sh x.sh` 分两步就绕过，
   * `npm install 任意包` 的安装脚本同样在跑第三方代码。而误伤是实打实的：
   * rustup、bun、deno、homebrew 的官方安装方式**就是** `curl … | sh`。
   *
   * 拦不住想拦的、误伤真实用法，那就不该留着假装有防线。真正的缓解手段是
   * 沙箱（限制它能碰什么）和用户看得见每一条命令，不是模式匹配。
   */
  {
    pattern:
      /(?:>>?|\btee\b|\bcp\b|\bmv\b|\bchmod\b|\bchown\b|\bln\b|-o\b|--output\b|\bSet-Content\b|\bAdd-Content\b|\bOut-File\b|\bCopy-Item\b)[^\n]*(?:\.ssh[\\/]|\bauthorized_keys\b|\bid_rsa\b|\bid_ed25519\b)/i,
    reason: '往 SSH 凭据里写入等于装一把长期后门，之后每次登录都绕开了这套权限模型',
  },
  {
    /**
     * **碰凭证文件本身**——读也算。
     *
     * 这条和上一条不同：上一条管的是「往凭证里写」，这条管的是「把凭证读出来」。
     * 读出来的后果不比写小：内容进上下文，随下一次请求发给 provider，
     * **发出去就收不回**。而模型没有任何正当理由需要看你的私钥或云凭据。
     *
     * ## 为什么不能只靠脱敏
     *
     * 输出脱敏（`secrets.ts` 的形状规则）是第二道，它按 PEM 包头、`sk-`/`ghp_`
     * 这类固定形状抓。**形状列不全**：自建服务的 token、数据库连接串里的密码、
     * 一段没有包头的 base64 私钥，它一个都认不出来。所以第一道是路径——
     * 让这些文件的内容根本不进管道，比事后猜它长什么样可靠得多。
     *
     * 两道都要：路径挡住已知位置，形状兜住换了位置的（比如项目里的 `.env`，
     * 那是项目文件、不该拦读，但值不该原样进上下文）。
     *
     * ## 为什么 `~/.qywork/config.json` 也在里面
     *
     * 那是**本程序自己的**全局配置：明文 apiKey、权限模式、classifier 指向都在
     * 那一个文件里。它躺在家目录，所以「工作区外写」那条已经挡住了写；
     * 这里补上读——key 被读走的代价和私钥一样。
     *
     * 注意它与工作区里的 `.qy/` / `.agents/` 是**两回事**：后者是项目自己的
     * agent 配置（mcp.json、skills、team.json），改它不构成提权（模型有
     * `run_command`，加不加工具能做的事一样多），不在这条规则里。
     */
    pattern:
      /(?:\.ssh[\\/]|\bid_rsa\b|\bid_ed25519\b|\bid_ecdsa\b|\.aws[\\/]credentials|\.config[\\/]gcloud[\\/]|\.kube[\\/]config|\.npmrc\b|\.netrc\b|\.pgpass\b|\.docker[\\/]config\.json|\.qywork[\\/]config\.json)/i,
    reason:
      '这是凭证文件（SSH 私钥、云厂商凭据、包管理器 token，或 qywork 自己的配置）。' +
      '读出来的内容会进上下文再发给模型供应商，发出去就收不回。' +
      '需要用到某个凭证时，用环境变量传给命令，不要把文件内容读进来',
  },
  {
    pattern: atCommandStart(
      String.raw`(?:shutdown|reboot|halt|poweroff|Stop-Computer|Restart-Computer)\b`,
    ),
    reason: '关机/重启会打断用户手上正在做的一切，一个写代码的 agent 没有理由需要它',
  },
  {
    pattern: atCommandStart(String.raw`(?:sudo|doas|runas|su)\b`),
    reason: '提权执行：跨过这条线之后，工作区边界和权限闸都不再有意义',
  },
  {
    pattern: /-Verb\s+RunAs\b/i,
    reason: 'Windows 上的提权（UAC 抬权），与 sudo 同类',
  },
  {
    pattern: /\bchmod\b[^\n]*\b(?:777|a\+rwx)\b[^\n]*\s(?:\/|~)[*/]*(?=\s|$)/i,
    reason: '把根目录/家目录整个改成全员可写，系统的权限模型当场作废',
  },
  {
    pattern: /\bdd\b[^\n]*\bof=\s*\/dev\/(?!null\b|zero\b|tty\b|stdout\b|stderr\b|u?random\b)/i,
    reason: 'dd 直接写裸设备，会把分区表和文件系统整块覆盖，没有任何撤销手段',
  },
  {
    pattern: />\s*\/dev\/(?:sd[a-z]|nvme\d|hd[a-z]|disk\d|mmcblk\d)/i,
    reason: '把输出重定向进块设备，等价于抹掉整块盘',
  },
  {
    pattern: atCommandStart(String.raw`(?:mkfs(?:\.\w+)?|diskpart|Format-Volume|Clear-Disk)\b`),
    reason: '格式化/重分区，会抹掉整块盘上的数据',
  },
  {
    pattern: /:\(\)\s*\{[^\n]*\|[^\n]*&[^\n]*\}\s*;?\s*:/,
    reason: 'fork 炸弹，会把进程表撑满到只能硬重启',
  },
]

// ───────────────────────── 裁决 ─────────────────────────

/**
 * 裁决一条 shell 命令。
 *
 * **只有拒绝清单。** 命中就拒，否则放行——没有「判不了」这一档，因为要判的
 * 那三类（越界写删、改系统状态、碰凭证）全都是确定性的，判不出它属于哪一类，
 * 就说明它不属于。
 */
export function decideCommand(command: string, ctx: PolicyContext): PolicyDecision {
  // 空命令唯一的特殊之处是没有可执行的内容，报清楚比让 shell 回一个空结果好。
  if (command.trim() === '') {
    return { kind: 'deny', reason: '命令为空或只有空白，没有可执行的内容' }
  }

  /*
   * 每条规则要么锚在**命令位**（`CMD_POS` 认 `;` `&&` `|` 换行之后的每一段），
   * 要么扫**整个原始串**（路径、凭证那几条）。所以 `ls && rm -rf ~` 里的第二段
   * 照样被抓到，**不需要先判「这是不是单条命令」**——那套组合符号扫描存在的
   * 理由只是保护允许清单，而这里没有允许清单。
   */
  for (const rule of HARD_DENY) {
    if (!rule.pattern.test(command)) continue
    if (rule.id === OUTSIDE_LOCATION_RULE && locationCoveredByExtras(command, ctx)) continue
    return { kind: 'deny', reason: rule.reason }
  }

  // 越界位置的字面写法。与 OUTSIDE_LOCATION_RULE 是同一条规则的另一半，见函数注释。
  const literal = literalOutsideHome(command, ctx)
  if (literal !== null) return { kind: 'deny', reason: literal }

  return { kind: 'allow', reason: '不属于「越界写删 / 改系统状态 / 碰凭证」这三类' }
}

/**
 * 家目录的**字面写法**。命中返回拒绝理由，否则 `null`。
 *
 * ## 这是上面那条硬拒绝漏掉的另一半
 *
 * `OUTSIDE_LOCATION_RULE` 那条正则只认**符号写法**——`~/`、`$HOME`、
 * `%USERPROFILE%`。实测（Windows，工作区 `<home>\Desktop\qywork`）：
 *
 * ```
 * deny      | Get-Content $env:USERPROFILE\.qywork\config.json
 * undecided | type <home>\.qywork\config.json
 * ```
 *
 * **同一个文件，两种拼法，两种结论。** 后者掉到分类器，而分类器是概率判断。
 * 一条确定性规则只认得出目标的一半写法，等于没有这条规则——
 * 绕过它不需要任何技巧，把 `~` 展开一下就行。
 *
 * ## 为什么不是把正则改宽一点
 *
 * 因为要判的不是「长得像不像家目录」，是「**这个路径在不在允许的范围里**」，
 * 而那必须拿真实的 homedir 和工作区去比。Windows 上工作区几乎总是在家目录**里面**
 * （`C:\Users\x\Desktop\proj`），所以一条「家目录一律拒」的正则会把工作区自己拒掉。
 * 这个判断做不成纯文本匹配。
 *
 * ## 判据
 *
 * 命令里的绝对路径，落在家目录或系统目录内、**且**不在工作区、
 * 也不在 `additionalDirectories` 里 → 拒绝。
 */
function literalOutsideHome(command: string, ctx: PolicyContext): string | null {
  const home = normalizeSeparators(homedir())
  const allowed = [ctx.workspaceRoot, ...(ctx.additionalDirectories ?? [])]
    .map(normalizeSeparators)
    .filter(Boolean)

  // 大小写必须折。Windows 与 macOS 的文件系统不区分大小写，`c:/users/x/.ssh/id_rsa`
  // 和 `C:/Users/x/.ssh/id_rsa` 是同一个文件——不折的话，把盘符敲成小写就绕过了
  // 这条规则，正是上面那段注释要消灭的「同一个文件，两种拼法，两种结论」。
  // 同文件的 isSystem 两条正则一开始就带 /i，只有这条比较漏了。
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
    // 允许的范围优先：工作区本身就在家目录里，先判它才不会自己拒自己。
    if (allowed.some((root) => inside(p, root))) continue

    const isHome = home !== '' && inside(p, home)
    const isSystem = /^\/etc(\/|$)/i.test(p) || /^[A-Za-z]:\/Windows(\/|$)/i.test(p)
    if (!isHome && !isSystem) continue

    return (
      `命令引用了 ${m[1]}，它在${isHome ? '家目录' : '系统目录'}里、且不在工作区` +
      `（也不在 additionalDirectories 里），效果必然越出工作区。` +
      `这台机器上没有内核级的路径边界，所以越界一律拒绝——` +
      `确实需要碰这个目录，请让用户把它加进 additionalDirectories。`
    )
  }
  return null
}

/**
 * 命令里出现的每一处「家目录/系统目录」引用，是不是都落在额外根目录里。
 *
 * ## 为什么要逐处检查，而不是「配了额外目录就整条放开」
 *
 * 用户把 `~/notes` 加进 `additionalDirectories`，意思是「这个目录可以碰」，
 * 不是「家目录全部可以碰」。整条放开的话，`cat ~/.ssh/id_rsa` 会一起被放行——
 * 那是把一个精确的授权当成了一张通行证。
 *
 * ## fail-closed
 *
 * 解析不出一个具体路径（比如 `$HOME` 后面跟的是变量而不是字面量），
 * 就当它**没被覆盖**，规则照常拒绝。这条规则是 deny 终局判决，没有分类器兜底，
 * 所以「拿不准」的正确方向是保持拒绝，而不是放行一次。
 *
 * ## `$env:USERPROFILE` 这类展开不了的写法
 *
 * `$env:USERPROFILE\notes` 里的 `\notes` 是字面量，`$env:USERPROFILE` 是展开式，
 * 我们照着本机 home 把它拼出来判定。**这只在本机 home 与命令实际展开一致时成立**，
 * 而那正是常态。不一致的极端情况（命令要在另一台机器上跑）落回拒绝，方向安全。
 */
function locationCoveredByExtras(command: string, ctx: PolicyContext): boolean {
  const extras = (ctx.additionalDirectories ?? []).map(normalizeSeparators).filter(Boolean)
  if (extras.length === 0) return false

  const home = normalizeSeparators(homedir())

  // 把每一处引用连同它后面的路径尾巴整个抓出来。
  // 结束于空白、引号、或 shell 组合符号——那些位置之后不再属于这个路径。
  const refs =
    /(?:^|(?<=[\s"'=(]))(?:~|\$\{?HOME\}?|\$env:USERPROFILE|\$env:HOMEPATH|%USERPROFILE%|%HOMEPATH%|\/etc\/|[A-Za-z]:[\\/]Windows[\\/])[^\s"'`;&|)]*/gi

  const found = command.match(refs)
  if (found === null || found.length === 0) return false

  return found.every((raw) => {
    const expanded = normalizeSeparators(
      raw.replace(
        /^(?:~|\$\{?HOME\}?|\$env:USERPROFILE|\$env:HOMEPATH|%USERPROFILE%|%HOMEPATH%)/i,
        home,
      ),
    )
    // 展开后仍带 `$` / `%` 说明里面还有别的变量，静态看不见它指向哪儿。
    if (/[$%]/.test(expanded)) return false
    return extras.some((root) => expanded === root || expanded.startsWith(`${root}/`))
  })
}

function normalizeSeparators(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}
