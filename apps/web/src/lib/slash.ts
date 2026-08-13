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
