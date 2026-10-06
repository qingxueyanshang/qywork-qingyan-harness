/**
 * `@qywork/plugins` 的对外接口。**此处列出的即对外承诺，未列出的均为内部实现。**
 * 使用具名导出，不用 `export *`（B6）；新增导出前先确认它确有包外调用方（B3）。
 *
 * 唯一的装配方是 `runtime/extensions.ts`。
 */

// 可信调用身份：runtime 的宿主能力实现据此裁决路径
export type { HostCallContext } from './host.ts'
// 加载：runtime 逐层调用后合并
export { loadPlugins, type PluginRegistry, pluginToolPrefix } from './loader.ts'
// 清单解析：server/api/plugins.ts 在安装前校验清单再落盘（通过动态 import 引用）
export { ManifestError, type PluginManifest, parseManifest } from './manifest.ts'
