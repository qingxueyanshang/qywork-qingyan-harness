/**
 * 覆盖范围：`../types.ts` 的 `PROVIDER_HTTP.fetchOptions` 在三个适配器
 * （`anthropic.ts`、`openai-compat.ts`、`openai-responses.ts`）中均传递到 fetch。
 *
 * 验证的是行为而非参数：Bun 的 fetch 自带 socket 空闲超时（默认 300 秒），正文静默达到时限
 * 即中止流。该值只能在进程启动时由 `BUN_CONFIG_HTTP_IDLE_TIMEOUT` 修改，因此另启动一个
 * 子进程将其设为 1 秒，在三种协议上各读取一条静默 9 秒的流：全部读取完毕即视为通过。
 * 子进程中同时执行一条不带 `timeout: false` 的裸 fetch 作对照，该请求必须被中止，
 * 否则本次实验未能验证中止行为。
 *
 * 耗时约 9 秒：Bun 1.4 为防止提前超时追加一个 4 秒刻度，实验必须超过追加后的期限。
 */
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

const CHILD = join(import.meta.dir, 'idle-timeout.child.ts')

describe('正文静默超过运行时的 socket 空闲超时', () => {
  test('三种协议的流均可读完，对照组裸 fetch 被中止', async () => {
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
