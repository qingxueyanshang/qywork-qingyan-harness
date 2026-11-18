/**
 * `schedule-race.test.ts` 的子进程入口：启动一份 `serve()`，由其自身的调度计时器执行认领。
 *
 * 独立成文件，而不是在测试中拼接源码：它因此随 `tsc --build` 与 lint 一并检查，
 * 修改 `serve()` 的签名会立即报错，而不是在执行到子进程时才失败。
 *
 * 参数依次是：主账本路径、`QYWORK_HOME`、工作区根、屏障端口、建立运行记录后再保持的毫秒数。
 * 先打开数据库并完成装配，再访问屏障：竞争窗口必须位于两个进程都准备就绪之后。
 */

import { formatLogLine, setLogSink } from '@qywork/core'
import { loadConfig } from '@qywork/runtime'
import { Store } from '@qywork/store'
import { serve } from './server.ts'

const [dbPath, home, workspaceRoot, barrierPort, holdMs] = Bun.argv.slice(2)
if (!dbPath || !home || !workspaceRoot || !barrierPort || !holdMs) {
  throw new Error('用法：schedule-race-child <db> <home> <workspaceRoot> <barrierPort> <holdMs>')
}

// 父测试以 stderr 为空判定子进程未出错。info 级的启动 / 停止记录不是错误，只输出 warn 与 error。
setLogSink((record) => {
  if (record.level !== 'info') process.stderr.write(`${formatLogLine(record)}\n`)
})

process.env.QYWORK_HOME = home
const store = new Store({ path: dbPath })
const config = await loadConfig()

// 屏障：两个子进程均到达后同时放行。
await fetch(`http://127.0.0.1:${barrierPort}/ready`)

const handle = serve({
  store,
  config,
  workspaceRoot,
  port: 0,
  host: '127.0.0.1',
  schedulerTickMs: 10,
})

// 等到有一方认领并建立运行记录（上限 30 秒）后再保持 `holdMs`。不要改回启动后固定等待：
// 慢机器上并行执行测试时，首次认领可能晚于固定的等待时间，两个进程都未认领即退出，用例误判失败。
const deadline = Date.now() + 30_000
while (Date.now() < deadline && !store.db.query('SELECT 1 FROM runs LIMIT 1').get()) await Bun.sleep(20)
await Bun.sleep(Number(holdMs))
handle.stop()
store.close()
