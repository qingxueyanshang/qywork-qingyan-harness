/**
 * 斜杠命令的判定——**纯字符串逻辑，不 import 任何组件**。
 *
 * 单独一个文件是被测试逼出来的：这几行本来在 `commands.ts` 里，而那个文件
 * 要 import 图标（`.tsx`），于是 `bun test` 一加载就去找 React 的 JSX runtime 并炸掉。
 * 判定逻辑没有理由拖着整张命令表和一堆 SVG 才能被验证。
 */

/**
 * 取草稿里的斜杠查询词。
 *
 * 只在**整段草稿就是一个 `/xxx`** 时才算。正文里出现的路径（`src/lib`）、
 * 代码里的除号、以及「/compact 然后呢」这种把命令当话说的句子都不该弹面板——
 * 一个动不动就跳出来的补全框比没有补全更烦。
 */
export function slashQuery(draft: string): string | null {
  if (!draft.startsWith('/')) return null
  const rest = draft.slice(1)
  if (/\s/.test(rest)) return null
  return rest
}

/**
 * 把一整段草稿拆成「命令名 + 后面那串话」。
 *
 * 和 `slashQuery` 是两件事，别合并：那个管**补全面板弹不弹**（打到一半就要判，
 * 所以带空格就收起来）；这个管**回车时这句话是不是一条命令**（那时候参数已经
 * 打完了，带空格才是常态）。合成一个函数的话，`/goal 把测试跑绿` 要么让面板
 * 一直挂着，要么根本不被当成命令。
 *
 * 不解析第二个参数。`/goal 3 个 bug 都修掉` 里的 3 是轮数还是正文？
 * 猜错一次就是按一个用户没说过的数开跑——所以只切第一个词，其余整段是参数。
 */
export function slashCall(draft: string): { name: string; arg: string } | null {
  if (!draft.startsWith('/')) return null
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(draft.trim())
  if (!m) return null
  return { name: m[1]!, arg: (m[2] ?? '').trim() }
}
