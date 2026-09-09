/**
 * 覆盖 `session-env.ts`：钩子按仓库根解析 `CLAUDE_SCRATCHPAD` 并建好目录；
 * 没有这个变量时退出码非零。
 */
import { describe, expect, test } from 'bun:test'
import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const SCRIPT = join(ROOT, 'scripts', 'session-env.ts')

async function run(value: string | null): Promise<{ code: number; stderr: string }> {
  const env: Record<string, string | undefined> = { ...process.env }
  delete env.CLAUDE_SCRATCHPAD
  if (value) env.CLAUDE_SCRATCHPAD = value
  const proc = Bun.spawn([process.execPath, SCRIPT], { env, stdout: 'pipe', stderr: 'pipe' })
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  return { code, stderr }
}

describe('SessionStart 钩子', () => {
  test('相对路径按仓库根解析并建好目录', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'session-env-'))
    const target = join(dir, 'scratch')
    const { code, stderr } = await run(relative(ROOT, target).replaceAll('\\', '/'))
    expect(stderr).toBe('')
    expect(code).toBe(0)
    expect((await stat(target)).isDirectory()).toBe(true)
  })

  test('没有 CLAUDE_SCRATCHPAD 时报错退出', async () => {
    const { code, stderr } = await run(null)
    expect(code).toBe(1)
    expect(stderr).toContain('CLAUDE_SCRATCHPAD')
  })
})
