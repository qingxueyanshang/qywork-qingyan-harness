/**
 * 覆盖 `stop-sidecar.ts`：开发脚本经标准输入请求 sidecar 停止，时限内退出不终止，超时后终止。
 * `qy serve` 对该指令的处理由 `packages/cli/src/serve-stop.test.ts` 覆盖。
 *
 * 原始失败形状：开发脚本结束与重启 sidecar 时直接终止进程，sidecar 的停止流程不执行。
 */

import { expect, test } from 'bun:test'
import { stopSidecar } from './stop-sidecar.ts'

/** 读到 `stop` 行后以 0 退出的子进程；`ignore` 为真时从不读取标准输入。 */
function child(ignore: boolean) {
  const script = ignore
    ? 'setInterval(() => {}, 1000)'
    : "for await (const c of Bun.stdin.stream()) if (new TextDecoder().decode(c).includes('stop\\n')) process.exit(0)"
  return Bun.spawn([process.execPath, '-e', script], {
    stdin: 'pipe',
    stdout: 'ignore',
    stderr: 'inherit',
  })
}

test('读到停止指令后自行退出时不终止进程', async () => {
  const proc = child(false)
  expect(await stopSidecar(proc, 10_000)).toBe(true)
  expect(proc.exitCode).toBe(0)
  expect(proc.signalCode).toBeNull()
})

test('时限内没有退出时终止进程', async () => {
  const proc = child(true)
  expect(await stopSidecar(proc, 300)).toBe(false)
  expect(proc.exitCode === 0 && proc.signalCode === null).toBe(false)
})

test('已退出的进程不再写入指令', async () => {
  const proc = child(true)
  proc.kill()
  await proc.exited
  expect(await stopSidecar(proc, 300)).toBe(true)
})
