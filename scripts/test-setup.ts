/**
 * `bun run test` 启动的测试子进程预载：按生产的那套编译 Solid 的 JSX。由 `bunfig.toml` 的
 * `[test] preload` 挂上，对整个仓库的测试生效。
 *
 * **必须用 `babel-preset-solid`，不能用 Bun 自带的 JSX 转换。** Solid 的响应式靠
 * 编译期把 `when={slow()}` 这类表达式包成取值函数；换成标准的自动运行时
 * （`jsx(Show, { when: slow() })`），表达式在调用那一刻就求了值，之后信号再变也不会
 * 重新渲染——测出来的是一个不响应的 Solid，测什么都是绿的。
 *
 * 只拦 `.tsx`：`.ts` 里没有 JSX，交给 Bun 自己的转译更快。
 *
 * **解析条件。** 测试子进程必须带 `--conditions browser`（由 `scripts/run-tests.ts` 统一设置）。
 * solid-js 的 `exports` 在 node 条件下指向服务端那份构建，`render()` 一调就抛
 * 「Client-only API called on the server side」。bunfig 里设不了这个，只能在命令行上给。
 *
 * **DOM 不在这里装。** happy-dom 的全局里带着它自己那份 `fetch`，服务端那些包的
 * 测试要的是 Bun 原生的——装成全局，一百多个测试当场变红。要 DOM 的测试自己
 * `GlobalRegistrator.register()`，用完卸掉（样例见 `LoadState.test.tsx`）。
 */
import { mkdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { transformSync } from '@babel/core'
import presetTypeScript from '@babel/preset-typescript'
import presetSolid from 'babel-preset-solid'
import { plugin } from 'bun'

const root = resolve(import.meta.dir, '..')
const testTemp = process.env.QYWORK_TEST_TEMP
if (!testTemp) throw new Error('测试必须通过 bun run test 启动')
const testTempPath = relative(root, resolve(testTemp)).replaceAll('\\', '/')
if (!/^\.tmp\/tests\/run-[^/]+$/.test(testTempPath)) {
  throw new Error(`测试临时目录必须位于 .tmp/tests：${testTemp}`)
}
mkdirSync(testTemp, { recursive: true })
for (const name of ['TEMP', 'TMP', 'TMPDIR']) process.env[name] = testTemp
process.env.GIT_CEILING_DIRECTORIES = testTemp

plugin({
  name: 'solid-jsx',
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async (args) => {
      const source = await Bun.file(args.path).text()
      // preset 的执行顺序是倒着来的：写在后面的先跑。先剥类型再编译 JSX，
      // 与 vite-plugin-solid 里的顺序一致。
      const out = transformSync(source, {
        filename: args.path,
        presets: [presetSolid, presetTypeScript],
        babelrc: false,
        configFile: false,
      })
      return { contents: out?.code ?? '', loader: 'js' }
    })
  },
})
