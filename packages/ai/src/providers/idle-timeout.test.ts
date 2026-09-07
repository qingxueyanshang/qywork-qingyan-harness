/**
 * 覆盖范围：`../types.ts` 的 `PROVIDER_HTTP.fetchOptions` 在三个适配器
 * （`anthropic.ts`、`openai-compat.ts`、`openai-responses.ts`）里都到达了 fetch。
 *
 * 验的是行为不是参数：Bun 的 fetch 自带 socket 空闲超时（默认 300 秒），正文静默到点
 * 就掐断流。这个值只能在进程启动时由 `BUN_CONFIG_HTTP_IDLE_TIMEOUT` 改，所以另起一个
 * 子进程把它压到 1 秒，让一条静默 4.5 秒的流跑三种协议：都读完才算通过。
 * 子进程里同时跑一条不带 `timeout: false` 的裸 fetch 作对照，它必须被掐，
 * 否则这次实验没有验到掐断。
 *
 * 耗时约 5 秒：Bun 的空闲定时器 4 秒一轮，静默短于一轮验不出掐断。
 */
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

const CHILD = join(import.meta.dir, 'idle-timeout.child.ts')

describe('正文静默超过运行时的 socket 空闲超时', () => {
  test('三种协议的流都读得完，对照组裸 fetch 被掐', async () => {
    const proc = Bun.spawn([process.execPath, CHILD], {
      env: { ...process.env, BUN_CONFIG_HTTP_IDLE_TIMEOUT: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) throw new Error(`子进程退出码 ${code}：${err}`)
    const result = JSON.parse(out) as Record<string, string>
    expect(result.control).toContain('timed out')
    expect(result.anthropic_messages).toBe('ok')
    expect(result.openai_chat_completions).toBe('ok')
    expect(result.openai_responses).toBe('ok')
  }, 20_000)
})
