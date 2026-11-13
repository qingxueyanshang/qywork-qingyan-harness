/**
 * 随脚本分发的网页构建产物：相对路径 → 文件的绝对路径。
 *
 * 源码中恒为 null。`scripts/build-sidecar.ts` 构建时以插件替换本模块的内容，替换为逐个文件的
 * `type: 'file'` 导入；构建脚本按本文件路径匹配，改名或移动时须同步修改该脚本，否则构建失败。
 * 源码运行时网页只能由 `--static` 提供。
 */
export const embeddedWeb: Readonly<Record<string, string>> | null = null
