/**
 * `@qywork/plugins` 的对外面。
 *
 * **这里列的就是承诺，没列的就是内部实现。** 之前五个模块走 `export *`，
 * 把三十五个符号推到包外，其中三十二个没有任何包外调用点——插件宿主、
 * 清单校验、出网闸、运行时探测全是内部实现。
 *
 * 唯一的装配方是 `runtime/extensions.ts`。
 *
 * 加新的对外符号时：先确认它真的有包外调用点，再往下面加一行。
 */

// 加载：runtime 逐层调用再合并
export { loadPlugins, type PluginRegistry, pluginToolPrefix } from './loader.ts'
// 清单解析：server/api/plugins.ts 安装前先校验一遍再落盘（走动态 import）
export { ManifestError, type PluginManifest, parseManifest } from './manifest.ts'
