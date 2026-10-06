/**
 * `bun run test` 启动的测试子进程预载：按生产环境的方式编译 Solid 的 JSX。由 `bunfig.toml` 的
 * `[test] preload` 加载，对整个仓库的测试生效。
 *
 * **必须用 `babel-preset-solid`，不能用 Bun 自带的 JSX 转换。** Solid 的响应式依赖
 * 编译期把 `when={slow()}` 这类表达式包装为取值函数；换成标准的自动运行时
 * （`jsx(Show, { when: slow() })`），表达式在调用时即求值，之后信号变化也不会
 * 重新渲染，测试的是一个不响应的 Solid，任何断言都会通过。
 *
 * 只拦截 `.tsx`：`.ts` 中没有 JSX，交给 Bun 自身的转译更快。
 *
 * **解析条件。** 测试子进程必须带 `--conditions browser`（由 `scripts/run-tests.ts` 统一设置）。
 * solid-js 的 `exports` 在 node 条件下指向服务端构建，调用 `render()` 即抛出
 * 「Client-only API called on the server side」。bunfig 中无法设置该项，只能在命令行中传入。
 *
 * **DOM 不在这里安装。** happy-dom 的全局对象带有其自身的 `fetch`，而服务端各包的
 * 测试需要 Bun 原生的 `fetch`：安装为全局后，一百多个测试立即失败。需要 DOM 的测试自行调用
 * `GlobalRegistrator.register()`，用完后卸载（样例见 `LoadState.test.tsx`）。
 */
import { mkdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
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
/*
 * 全局层的根同样位于隔离目录中。`globalScopeRoot()` 缺省为 `~/.qywork`，其中存有开发者本人的
 * 明文 key、账本与定时任务文件；任何启动 `serve()` 或读取配置的测试若未设置该变量，
 * 就会基于真实数据运行，甚至重命名真实文件。自行设置了 `QYWORK_HOME` 的测试仍会覆盖此值。
 */
process.env.QYWORK_HOME = join(testTemp, 'home')
mkdirSync(process.env.QYWORK_HOME, { recursive: true })

plugin({
  name: 'solid-jsx',
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async (args) => {
      const source = await Bun.file(args.path).text()
      // preset 按逆序执行：写在后面的先执行。先剥离类型再编译 JSX，
      // 与 vite-plugin-solid 中的顺序一致。
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
