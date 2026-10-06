/**
 * 斜杠命令的判定：纯字符串逻辑，不 import 任何组件。
 *
 * 单独成文件是为了可测试：命令表所在的 `commands.ts` 会 import 图标（`.tsx`），
 * `bun test` 加载它时会查找 React 的 JSX runtime 并失败。判定逻辑不应依赖整张
 * 命令表与全部 SVG 才能验证。
 */

/**
 * 取得草稿中的斜杠查询词。
 *
 * 仅当整段草稿恰好是一个 `/xxx` 时计入。正文中的路径（`src/lib`）、
 * 代码中的除号，以及「/compact 然后呢」这类把命令写进句子的输入都不应弹出面板：
 * 频繁自动弹出的补全框比没有补全更影响输入。
 */
export function slashQuery(draft: string): string | null {
  if (!draft.startsWith('/')) return null
  const rest = draft.slice(1)
  if (/\s/.test(rest)) return null
  return rest
}

/**
 * 把整段草稿拆分为命令名与其后的参数文本。
 *
 * 与 `slashQuery` 职责不同，不要合并：`slashQuery` 决定补全面板是否弹出（输入过程中即需判断，
 * 因此出现空格即收起）；本函数判定回车时整段输入是否为一条命令（此时参数已
 * 输入完毕，包含空格是常态）。合并为一个函数时，`/goal 修复全部测试` 要么使面板
 * 一直显示，要么不被识别为命令。
 *
 * 不解析第二个参数：`/goal 3 个 bug 都修掉` 中的 3 无法确定是轮数还是正文。
 * 推测错误会按用户未指定的数值开始执行，因此只切分第一个词，其余整段作为参数。
 */
export function slashCall(draft: string): { name: string; arg: string } | null {
  if (!draft.startsWith('/')) return null
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(draft.trim())
  if (!m) return null
  return { name: m[1]!, arg: (m[2] ?? '').trim() }
}

export type SlashDispatch<T> =
  | { kind: 'run'; command: T; arg?: string }
  | { kind: 'await_argument'; command: T }
  | { kind: 'message' }

/**
 * 使发送按钮、移动端提交与键盘回车采用同一种命令语义。
 *
 * 已知的无参命令直接执行；已知的带参命令缺少参数时保留在草稿中，等待用户补充；
 * 未知命令或为无参命令附带参数时，仍按正文发送，不得静默丢弃用户输入。
 */
export function slashDispatch<T extends { slash?: string; arg?: unknown }>(
  draft: string,
  commands: readonly T[],
): SlashDispatch<T> {
  const call = slashCall(draft)
  if (!call) return { kind: 'message' }
  const command = commands.find((item) => item.slash === call.name)
  if (!command) return { kind: 'message' }
  if (command.arg && !call.arg) return { kind: 'await_argument', command }
  if (!command.arg && call.arg) return { kind: 'message' }
  return { kind: 'run', command, ...(call.arg ? { arg: call.arg } : {}) }
}
