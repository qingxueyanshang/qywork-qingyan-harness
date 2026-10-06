/**
 * `startup-lifecycle.test.ts` 的子进程入口：执行一次 `qy tui` 的启动段。
 *
 * 不经由 `index.ts`：无参数时它在非 TTY 下只打印用法，子进程无法进入交互模式。
 * stdin 立即 EOF，`runTui` 未读到任何一行即结束：要验证的是它打开两个库的行为。
 *
 * 使用独立文件而不是在测试中拼接源码：这样它随 `tsc --build` 与 lint 一起被检查。
 */

import { runTui } from './tui.ts'

const [home, workspaceRoot] = Bun.argv.slice(2)
if (!home || !workspaceRoot) throw new Error('用法：tui-child <home> <workspaceRoot>')
process.env.QYWORK_HOME = home
process.exit(await runTui(workspaceRoot))
