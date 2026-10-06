/**
 * 两个 babel preset 自身不带类型声明。`scripts/test-setup.ts` 只把它们原样交给
 * `transformSync`，用到的只有 `PluginItem` 这一个类型。
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
