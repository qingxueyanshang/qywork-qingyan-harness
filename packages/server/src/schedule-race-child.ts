/**
 * `schedule-race.test.ts` 的子进程入口：起一份 `serve()`，让它自己的调度计时器去认领。
 *
 * 单独一个文件而不是在测试里拼一段源码：这样它跟着 `tsc --build` 与 lint 一起被检查，
 * 改了 `serve()` 的签名会当场变红，而不是在跑到子进程时才失败。
 *
 * 参数依次是：主账本路径、`QYWORK_HOME`、工作区根、屏障端口、退出前等待的毫秒数。
 * 先开库、装配完，再去碰屏障——竞争窗口要落在两个进程都准备好之后。
 */

import { formatLogLine, setLogSink } from '@qywork/core'
import { loadConfig } from '@qywork/runtime'
import { Store } from '@qywork/store'
import { serve } from './server.ts'

const [dbPath, home, workspaceRoot, barrierPort, holdMs] = Bun.argv.slice(2)
if (!dbPath || !home || !workspaceRoot || !barrierPort || !holdMs) {
  throw new Error('用法：schedule-race-child <db> <home> <workspaceRoot> <barrierPort> <holdMs>')
}

// 父测试按「stderr 为空」判子进程没出错。info 级的启动 / 停止记录不是错误，只放行 warn 与 error。
setLogSink((record) => {
  if (record.level !== 'info') process.stderr.write(`${formatLogLine(record)}\n`)
})

process.env.QYWORK_HOME = home
const store = new Store({ path: dbPath })
const config = await loadConfig()

// 屏障：两个子进程都到齐之后同时放行。
await fetch(`http://127.0.0.1:${barrierPort}/ready`)

const handle = serve({
  store,
  config,
  workspaceRoot,
  port: 0,
  host: '127.0.0.1',
  schedulerTickMs: 10,
})

await Bun.sleep(Number(holdMs))
handle.stop()
store.close()
