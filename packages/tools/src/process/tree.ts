/** 进程树：终止整个进程树，以及判定进程树是否仍在工作。 */

import { readdir, readFile } from 'node:fs/promises'

/**
 * 终止整个进程树。
 *
 * 不能只调用 `proc.kill()`：spawn 启动的不是命令本身，而是一个 shell
 * （`commandShell()` 的 argv 加命令字符串）。实际执行命令的是它的子进程，
 * 而 `proc.kill()` 只终止该 shell：实测 shell 退出后服务进程仍在监听、孙进程
 * 持有 stdout，管道 3 秒内没有 EOF（Windows 11 / Bun 1.3.14）。
 *
 * 管道没有 EOF 比服务未终止更严重。若以管道 EOF 作为命令结束的判据，该次
 * `registry.execute` 永不返回，而 `agent/loop/tool-wave.ts` 中调用它的位置外层没有任何超时。结果
 * 逐层传导：`run-control.ts` 的 finally 不执行、`runs.release` 不执行，
 * 该会话此后一直以「已有任务在执行」拒绝新任务，直到重启 `qy serve`。触发条件不限于
 * 启动服务器这类少见情况：任何经 shell 派生子进程的命令（`npm test` → node、
 * `python x.py`）遇到超时或用户中断都会触发。
 *
 * 终止进程树可同时消除这两个问题，但无法终止已脱离父子关系的孤儿进程：进程树解散后再执行一次
 * `taskkill /F /T`，返回 `The process not found`，而管道仍没有 EOF。因此命令是否结束
 * 不能以管道 EOF 判定，该判据由 `collectProcess` 负责：以进程退出为准。
 *
 * 平台：
 * - Windows：`taskkill /F /T`，`/T` 包括全部子孙进程。上文数据为本机实测。
 * - 其余平台：向以 `proc.pid` 为组号的进程组发送 SIGKILL。以 `detached` 启动的子进程自成一组，
 *   组号即其 pid，shell 派生的子孙进程与 bwrap 命名空间中的进程都在组内（Linux / WSL2 实测，
 *   macOS 未实测）。非 detached 启动的子进程不是组长，不存在以其 pid 为组号的组，
 *   调用抛出 ESRCH，转为终止单个进程；该调用不会命中 `qy serve` 自身所在的组。
 *   不要改成先用 `process.getpgid` 验证组长：Bun 1.3.14 没有该方法，验证始终不通过，
 *   进程树终止将退化为只终止 shell。
 *
 * runner（`runner.ts`）与 serve 进程共用本函数。
 */
export function killTree(proc: { pid: number; kill(): void }): void {
  if (process.platform === 'win32') {
    // 同步等待终止完成：异步时调用方随即读取流，可能读到尚未关闭的管道。
    // `windowsHide`：没有控制台的进程（runner、桌面外壳启动的 serve）启动 taskkill 时另开一个可见的控制台窗口。
    Bun.spawnSync(['taskkill', '/F', '/T', '/PID', String(proc.pid)], {
      stdout: 'ignore',
      stderr: 'ignore',
      windowsHide: true,
    })
    return
  }
  try {
    process.kill(-proc.pid, 'SIGKILL')
    return
  } catch {
    // 该进程组不存在：子进程不是以 detached 启动的，或整组已经退出。
  }
  proc.kill()
}

/**
 * 判定进程树是否仍在工作时的采样间隔与门槛。
 *
 * 两次采样之间，整棵树的 CPU 时间增长不少于间隔的 5%（一个核的 5%），或读写字节数增长不少于
 * 64KB，即视为仍在工作。计算任务通常占满一个核；等待输入、网络或子进程的进程接近 0。
 * 每秒派生一次 `sleep` 的轮询脚本约占 1%，按停滞处理。
 */
const BUSY_WINDOW_MS = 2000
const BUSY_CPU_SHARE = 0.05
const BUSY_IO_BYTES = 64 * 1024
/** 读取进程表的时限。PowerShell 启动与 CIM 查询通常在 2 秒内完成，超时按读取失败处理。 */
const PROCESS_TABLE_TIMEOUT_MS = 15_000

interface ProcessRow {
  pid: number
  ppid: number
  cpuMs: number
  ioBytes: number
}

/**
 * 以 `pid` 为根的进程树此刻是否仍在工作：相隔 `BUSY_WINDOW_MS` 读取两次进程表，比较整棵树的
 * CPU 时间与读写字节数。无法读取进程表（平台不支持、进程已退出）时返回 false，按无输出处理。
 */
export async function treeBusy(pid: number): Promise<boolean> {
  const before = await treeUsage(pid)
  if (before === null) return false
  await Bun.sleep(BUSY_WINDOW_MS)
  const after = await treeUsage(pid)
  if (after === null) return false
  return (
    after.cpuMs - before.cpuMs >= BUSY_CPU_SHARE * BUSY_WINDOW_MS ||
    after.ioBytes - before.ioBytes >= BUSY_IO_BYTES
  )
}

async function treeUsage(root: number): Promise<{ cpuMs: number; ioBytes: number } | null> {
  const rows = await Promise.race([
    processTable().catch(() => null),
    Bun.sleep(PROCESS_TABLE_TIMEOUT_MS).then(() => null),
  ])
  if (rows === null) return null
  const byPid = new Map(rows.map((r) => [r.pid, r]))
  if (!byPid.has(root)) return null
  const children = new Map<number, number[]>()
  for (const r of rows) {
    if (r.pid === r.ppid) continue
    const list = children.get(r.ppid)
    if (list) list.push(r.pid)
    else children.set(r.ppid, [r.pid])
  }
  // 进程号会被复用，父进程号可能指向一个无关的新进程而形成环；`seen` 保证每个进程只计一次。
  let cpuMs = 0
  let ioBytes = 0
  const seen = new Set<number>()
  const stack = [root]
  while (stack.length) {
    const p = stack.pop() as number
    if (seen.has(p)) continue
    seen.add(p)
    const r = byPid.get(p)
    if (r) {
      cpuMs += r.cpuMs
      ioBytes += r.ioBytes
    }
    stack.push(...(children.get(p) ?? []))
  }
  return { cpuMs, ioBytes }
}

/**
 * 本机全部进程的父子关系、累计 CPU 时间与读写字节数。
 *
 * - Windows：`Win32_Process`，CPU 时间单位为 100 纳秒，读写字节含文件与管道；
 * - Linux：`/proc/<pid>/stat` 的 utime + stime（按每秒 100 个时钟周期换算）与 `/proc/<pid>/io`；
 * - 其他：`ps` 的累计 CPU 时间，不含读写字节。
 */
async function processTable(): Promise<ProcessRow[]> {
  if (process.platform === 'win32') {
    const ps = Bun.spawn(
      [
        'powershell.exe',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) ' +
          '$($_.KernelModeTime + $_.UserModeTime) $($_.ReadTransferCount + $_.WriteTransferCount)" }',
      ],
      { stdout: 'pipe', stderr: 'ignore', windowsHide: true },
    )
    const text = await new Response(ps.stdout).text()
    await ps.exited
    return text
      .split(/\r?\n/)
      .map((l) => l.trim().split(/\s+/).map(Number))
      .filter((f) => f.length === 4 && f.every(Number.isFinite))
      .map(([pid, ppid, cpu, io]) => ({
        pid: pid as number,
        ppid: ppid as number,
        cpuMs: (cpu as number) / 10_000,
        ioBytes: io as number,
      }))
  }
  if (process.platform === 'linux') {
    const rows: ProcessRow[] = []
    for (const name of await readdir('/proc')) {
      if (!/^\d+$/.test(name)) continue
      try {
        const stat = await readFile(`/proc/${name}/stat`, 'utf8')
        // 进程名可含空格与括号，字段从最后一个右括号之后数起。
        const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
        let ioBytes = 0
        try {
          const io = await readFile(`/proc/${name}/io`, 'utf8')
          for (const m of io.matchAll(/^(?:read|write)_bytes: (\d+)$/gm)) ioBytes += Number(m[1])
        } catch {
          // 无权读取 io 时只按 CPU 判定。
        }
        rows.push({
          pid: Number(name),
          ppid: Number(f[1]),
          cpuMs: ((Number(f[11]) + Number(f[12])) * 1000) / 100,
          ioBytes,
        })
      } catch {
        // 进程在读取期间退出。
      }
    }
    return rows
  }
  const ps = Bun.spawn(['ps', '-A', '-o', 'pid=,ppid=,time='], { stdout: 'pipe', stderr: 'ignore' })
  const text = await new Response(ps.stdout).text()
  await ps.exited
  const rows: ProcessRow[] = []
  for (const line of text.split('\n')) {
    const [pid, ppid, time] = line.trim().split(/\s+/)
    if (!pid || !ppid || !time) continue
    // [[dd-]hh:]mm:ss[.cc]
    const [days, clock] = time.includes('-') ? time.split('-') : ['0', time]
    const parts = (clock as string).split(':').map(Number)
    const secs = parts.reduce((acc, v) => acc * 60 + v, 0) + Number(days) * 86_400
    rows.push({ pid: Number(pid), ppid: Number(ppid), cpuMs: secs * 1000, ioBytes: 0 })
  }
  return rows
}
