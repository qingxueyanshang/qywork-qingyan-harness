/**
 * 两个 babel preset 自己不带类型。`scripts/test-setup.ts` 只把它们原样交给
 * `transformSync`，用得着的就是 `PluginItem` 这一个形状。
 */
declare module 'babel-preset-solid' {
  import type { PluginItem } from '@babel/core'

  const preset: PluginItem
  export default preset
}

declare module '@babel/preset-typescript' {
  import type { PluginItem } from '@babel/core'

  const preset: PluginItem
  export default preset
}
