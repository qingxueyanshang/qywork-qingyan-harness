/**
 * `@qywork/plugins` 的对外面。**这里列的就是承诺，没列的就是内部实现。**
 * 具名导出，不用 `export *`（B6）；加一行之前先确认它真有包外调用点（B3）。
 *
 * 唯一的装配方是 `runtime/extensions.ts`。
 */

// 加载：runtime 逐层调用再合并
export { loadPlugins, type PluginRegistry, pluginToolPrefix } from './loader.ts'
// 清单解析：server/api/plugins.ts 安装前先校验一遍再落盘（走动态 import）
export { ManifestError, type PluginManifest, parseManifest } from './manifest.ts'
