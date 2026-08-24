/**
 * 工具步骤的**纯呈现逻辑**——截断、分桶、取值、格式化。
 *
 * 单独一个文件不是为了整洁，是为了**能被测**：这些函数原本住在 `Transcript.tsx`
 * 里，而 `bun test` 一加载 `.tsx` 就去找 JSX runtime 然后炸掉
 * （`lib/slash.ts` 是同一个原因拆出来的）。它们每一个都有真实的边界条件，
 * 靠肉眼看渲染结果验不出来。
 *
 * 判据很简单：**不碰 DOM、不读 store 的，都不该待在组件文件里。**
 */

const NEWLINE = String.fromCharCode(10)
const CARRIAGE_RETURN = String.fromCharCode(13)

/** 大数收成 12.3K / 1.2M：读数条是一行扫过去的东西，六位数字读不出量级。 */
export function compact(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** 命中率要用到的那几格。写成结构类型而不是 import `RunUsage`：这个文件要能被单测直接喂数据。 */
interface UsageLike {
  inputTokens: number
  cachedTokens: number | null
  cacheWriteTokens: number | null
  turns: readonly {
    input: number
    cached: number | null
    cacheWrite: number | null
    /** provider = 模型真回报；estimated = 本地估算兜底。 */
    source: 'provider' | 'estimated'
  }[]
}

/**
 * 缓存命中率。
 *
 * **报比例不报绝对值**：绝对值要和输入量对着看才有意义，那个除法不该让用户做。
 *
 * ## 分母是「这次请求的输入总量」，不是 `inputTokens`
 *
 * 三家适配器统一收敛到**排他口径**：`inputTokens` 里只装未命中的那部分
 * （`providers/anthropic.ts` 原生如此，`openai-compat.ts` / `openai-responses.ts`
 * 明确减掉了命中量）。拿它当分母等于把命中的那一大块从分母里抠掉，
 * 算出来的比例恒偏高——缓存命中高的时候能轻松超过 100%，
 * 794K 命中 / 2K 未命中会打印成 39700%。
 * 正确的分母是 `未命中 + 命中 + 写入`。
 *
 * ## 看**最后一次**模型调用，不看整轮累计
 *
 * 一轮里第一次调用必然没有命中，累计口径把它摊进去，长轮次的率会被压低；
 * 而用户盯着这个数字想知道的是「现在缓存生效了吗」。
 * **不要改成整轮累计**——这一格的语义就是最新那一次，同一行上其余几格是累计
 * 不构成改它的理由。没有逐轮记录（老数据、断流）才回落到整轮累计，
 * **回落不能显示 `—`**：「有缓存但没逐轮记录」和「没有缓存」是两回事。
 *
 * ## 最后一次没回报缓存字段就是 0，不是跳过
 *
 * 跳过它去找更早那条报过的，屏幕上就会挂着一个几轮之前的数——最新这次
 * 全价重付了，读数却还写着 93%。计费那侧早就把「没回报」按 0 命中算
 * （`ai/catalog.ts` 的 `computeCost`：`cachedTokens ?? 0` 走全价输入），
 * 读数跟着同一个口径才只有一本账。
 *
 * 「未回报」只留给**这一次连 usage 都没到**的情形（`source === 'estimated'`）：
 * 那时候我们不知道命中多少，也不知道输入多少，写 0 是编的。
 */
export function hitRate(usage: UsageLike): string {
  const last = usage.turns[usage.turns.length - 1]
  // 这一次连 usage 都没回来：命中多少、输入多少都不知道，写 0 是编的。
  if (last && last.source !== 'provider') return '未回报'
  const cached = last ? (last.cached ?? 0) : usage.cachedTokens
  if (cached === null) return '未回报'

  const denom = last
    ? last.input + cached + (last.cacheWrite ?? 0)
    : usage.inputTokens + cached + (usage.cacheWriteTokens ?? 0)
  if (denom <= 0) return '—'
  return `${((cached / denom) * 100).toFixed(2)}%`
}

export const TARGET_MAX = 48

/**
 * 动作行 target 净化：压空白、超长截断。
 *
 * **路径保尾部**（`…/submit/submit_core.py`），其余保头部（长正则、长模式串）。
 * 信息在哪一头就留哪一头——两头都截同一侧，必然有一类会被截掉有用的那半。
 */
export function sanitizeTarget(target: string): string {
  const clean = target.replace(/\s+/g, ' ').trim()
  if (clean.length <= TARGET_MAX) return clean
  return /[/\\]/.test(clean)
    ? `…${clean.slice(-(TARGET_MAX - 1))}`
    : `${clean.slice(0, TARGET_MAX - 1)}…`
}

/**
 * 外置工具的目标去掉 `mcp:` / `plugin:` 前缀。**只在显示时剥。**
 *
 * 后端那份必须带前缀：权限 scope 是 `${effect}:${target}`，target 是它唯一的载体，
 * 剥掉之后一个 id 叫 `github` 的插件的 `search` 和那个 MCP server 的 `search`
 * 会撞出同一个 scope 串。而卡片上对象名已经写着「MCP」/「插件」，
 * 目标里再说一遍就成了「调用 MCP · mcp:github/search」。
 */
export function displayTarget(target: string): string {
  return target.replace(/^(?:mcp|plugin):/, '')
}

/** 终态字样。**成功是空字符串**——一屏几十行全写「成功」等于没有信息。 */
export function statusWord(status: 'running' | 'success' | 'failure' | undefined): string {
  return status === 'failure' ? '失败' : ''
}

/**
 * 一次调用改了多少行：`+N −M`。
 *
 * 两个数早就随 `ToolOutcome.fileChanges` 进了账本（`tools/src/files.ts` 的
 * `countDiff` 算的），只是一直没有人渲染。一次调用可能动多个文件，所以求和。
 *
 * **两个数都是 0 就不给角标**：`+0 −0` 占着行尾却什么也没说。
 */
export function fileDelta(
  changes: readonly { additions: number; deletions: number }[] | undefined,
): { additions: number; deletions: number } | null {
  if (!changes || changes.length === 0) return null
  let additions = 0
  let deletions = 0
  for (const c of changes) {
    additions += c.additions
    deletions += c.deletions
  }
  return additions === 0 && deletions === 0 ? null : { additions, deletions }
}

/** 列表型结果：目录项、命中行、匹配文件——形状都是 string[]，渲染方式也一样。 */
export function listOf(data: Record<string, unknown>): string[] | null {
  for (const key of ['entries', 'matches', 'files']) {
    const v = data[key]
    if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string')) {
      return v as string[]
    }
  }
  return null
}

/** 参数表：跳过空值与大值——长文本走专用块，塞进键值表会把卡片撑爆。 */
export function argsRows(args: Record<string, unknown>): [string, string][] {
  const rows: [string, string][] = []
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null || v === '') continue
    const text = typeof v === 'string' ? v : JSON.stringify(v)
    if (text.length > 400) continue
    rows.push([k, text])
  }
  return rows
}

/**
 * 待办清单型参数：`{ todos: [{ content, status }, …] }`。
 *
 * **按形状认，不按工具名认**——同文件的 `listOf` / `diffFrom` 是同一个路子，
 * 展开体里那个 Switch 从来不问「这一步是谁调的」。
 *
 * 认不出就返回 null（不是空数组）：空数组会让调用方渲染出一个空的清单框，
 * 而「没有清单」应该走通用参数表那一支。
 */
export function todosOf(
  args: Record<string, unknown>,
): { id: string; content: string; status: 'pending' | 'in_progress' | 'completed' }[] | null {
  const raw = args.todos
  if (!Array.isArray(raw) || raw.length === 0) return null
  const out: { id: string; content: string; status: 'pending' | 'in_progress' | 'completed' }[] = []
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i] as Record<string, unknown> | null
    if (!t || typeof t !== 'object') return null
    if (typeof t.content !== 'string') return null
    const status = t.status
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') return null
    // 落库的 args 里没有 id（那是工具补的），行渲染又要一个稳定 key，所以按位置补。
    out.push({ id: typeof t.id === 'string' ? t.id : `todo_${i + 1}`, content: t.content, status })
  }
  return out
}

export function firstString(args: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = args[k]
    if (typeof v === 'string' && v.trim()) return v
  }
  return ''
}

/**
 * 把回车符覆盖掉的中间帧丢掉，每行只留最后一帧。
 *
 * 带进度显示的命令（curl、npm、pip、cargo）用裸回车符回到行首重画同一行，
 * 终端里只显示最后一帧。`<pre>` 把它当普通空白，不折叠就会把全部帧一起排出来。
 *
 * **必须先剥掉行尾的回车符**：CRLF 行尾的那个不是覆盖标记，
 * 按覆盖处理会把整行当成残留丢空。
 */
export function collapseCarriageReturns(text: string): string {
  if (!text.includes(CARRIAGE_RETURN)) return text
  return text
    .split(NEWLINE)
    .map((line) => {
      const body = line.endsWith(CARRIAGE_RETURN) ? line.slice(0, -1) : line
      return body.slice(body.lastIndexOf(CARRIAGE_RETURN) + 1)
    })
    .join(NEWLINE)
}

export const CLAMP = 20_000

/** 超长正文截断并**说清还剩多少**：只截不说会让人以为文件就这么长。 */
export function clamp(text: string): string {
  return text.length <= CLAMP
    ? text
    : `${text.slice(0, CLAMP)}${NEWLINE}…（还有 ${text.length - CLAMP} 字）`
}

/**
 * 从编辑参数里取出可以红绿呈现的两段。
 *
 * 先认 old/new 这类成对字段，再回落到整段 patch。都取不到返回 null——
 * 返回一个空 diff 会在界面上画出一个空的红绿框。
 */
export function diffFrom(args: Record<string, unknown>): { removed: string; added: string } | null {
  const removed = firstString(args, 'old_string', 'old', 'old_text', 'before')
  const added = firstString(args, 'new_string', 'new', 'new_text', 'after')
  if (removed || added) {
    return { removed: removed ? `- ${removed}${NEWLINE}` : '', added: added ? `+ ${added}` : '' }
  }
  const patch = firstString(args, 'patch', 'diff')
  if (!patch) return null
  const lines = patch.split(NEWLINE)
  return {
    removed: lines.filter((l) => l.startsWith('-')).join(NEWLINE),
    added: lines.filter((l) => l.startsWith('+')).join(NEWLINE),
  }
}

/**
 * 停止原因的说法。
 *
 * **住在这里而不是组件里**：会话流的收尾条和运行详情面板都要显示它。
 * 抄第二份的代价已经付过一次——面板那边直接把 `max_steps` 这种英文码贴给了用户。
 *
 * 认不出的码原样返回：协议里这是个封闭枚举，落到这里说明前后端版本对不上，
 * 显示原码比显示一句编出来的话诚实。
 */
export function stopReasonLabel(reason: string): string {
  const map: Record<string, string> = {
    completed: '已完成',
    max_steps: '已达步数上限',
    // 与 max_steps 分开说：那是步数不够，这是多给步数也没用。
    no_progress: '原地重复，已停下',
    user_interrupt: '已中断',
    // 与「已中断」分开说：用户没点过任何东西，是服务进程没了（热重载、崩溃、关机）。
    // 两句都说「已中断」的话，用户看到的是一个自己没做过的动作。
    process_exit: '服务进程退出',
    // 不再产生：权限拒绝是工具级失败，不是 run 的终点。留着认旧记录——
    // 库里已有的 run 存着这个码，删掉它们的收尾条就显示成英文原码。
    permission_denied: '授权被拒绝',
    output_truncated: '输出被截断',
    provider_error: '模型服务出错',
    internal_guard: '进程中途退出，结果不可信',
  }
  return map[reason] ?? reason
}
