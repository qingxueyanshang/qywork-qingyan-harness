/**
 * 编译时嵌入的网页构建产物：相对路径 → 嵌入文件的路径。
 *
 * 源码中恒为 null。`scripts/build-sidecar.ts` 编译时以插件替换本模块的内容，替换为逐个文件的
 * `type: 'file'` 导入；构建脚本按本文件路径匹配，改名或移动时须同步修改该脚本，否则编译失败。
 * 源码运行时网页只能由 `--static` 提供。
 */
export const embeddedWeb: Readonly<Record<string, string>> | null = null
