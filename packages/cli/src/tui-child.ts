/**
 * `startup-lifecycle.test.ts` 的子进程入口：跑一次 `qy tui` 的启动段。
 *
 * 不走 `index.ts`：无参数时它在非 TTY 下只打印用法，交互式那条路从子进程进不去。
 * stdin 立刻 EOF，`runTui` 读不到一行就收尾——要验的是它开两库那一段做了什么。
 *
 * 单独一个文件而不是在测试里拼一段源码：这样它跟着 `tsc --build` 与 lint 一起被检查。
 */

import { runTui } from './tui.ts'

const [home, workspaceRoot] = Bun.argv.slice(2)
if (!home || !workspaceRoot) throw new Error('用法：tui-child <home> <workspaceRoot>')
process.env.QYWORK_HOME = home
process.exit(await runTui(workspaceRoot))
