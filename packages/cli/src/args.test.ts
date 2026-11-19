/**
 * 覆盖 `index.ts` 的 `main` 与 `parseFlags`：子命令后的 `--help` 只输出用法，`exec` 遇到未知参数时报错退出，
 * `exec --model` 按指定模型发出请求、未配置的模型报错退出。
 *
 * 失败形状：`qy exec --help` 把 `--help` 当作任务描述，按当前目录创建工作区与会话并发出一次真实请求。
 * 测试启动真实进程，核对退出码、输出，以及数据目录中未创建数据库文件。
 */

import { afterAll, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, 'index.ts')

/** 记录请求体中的模型名；一律返回 401，`auth_failed` 不重发，一次即进入终态。 */
const requestedModels: string[] = []
const provider = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = (await req.json().catch(() => ({}))) as { model?: string }
    if (body.model) requestedModels.push(body.model)
    return new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
  },
})

afterAll(async () => {
  await provider.stop(true)
})

/** 两个模型都配置在同一个接口下，默认模型为第一个。 */
const TWO_MODELS = {
  active: { provider: 'fake', model: 'deepseek-v4-flash' },
  providers: {
    fake: {
      kind: 'openai_chat_completions',
      apiKey: 'sk-fake',
      baseUrl: `http://127.0.0.1:${provider.port}/v1`,
      models: { 'deepseek-v4-flash': {}, 'deepseek-v4-pro': {} },
    },
  },
  mode: 'auto',
}

async function run(args: string[], config?: unknown) {
  const home = await mkdtemp(join(tmpdir(), 'qywork-cli-args-'))
  if (config) await writeFile(join(home, 'config.json'), JSON.stringify(config), 'utf8')
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    env: { ...process.env, QYWORK_HOME: home },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { out, err, code, db: existsSync(join(home, 'qywork.sqlite3')) }
}

test('exec --help 只输出用法，不创建数据库、不发送请求', async () => {
  const r = await run(['exec', '--help'])
  expect(r.code).toBe(0)
  expect(r.out).toContain('qy exec')
  expect(r.db).toBe(false)
})

test('exec 遇到未知参数时报错退出，不创建数据库', async () => {
  const r = await run(['exec', '--bogus', '写一段说明'])
  expect(r.code).toBe(2)
  expect(r.err).toContain('未知参数：--bogus')
  expect(r.db).toBe(false)
})

test('exec --model 按指定的模型发出请求，不使用配置中的默认模型', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'qywork-cli-args-ws-'))
  const before = requestedModels.length
  const r = await run(['exec', '--model', 'deepseek-v4-pro', '--cwd', ws, '汇报一次'], TWO_MODELS)
  expect(r.code).toBe(1)
  expect(requestedModels.slice(before)).toEqual(['deepseek-v4-pro'])
})

test('exec --model 无法确定接口时报错退出，不创建数据库、不发送请求', async () => {
  // 两个非默认接口都配置了同一个模型：按枚举顺序选择会把请求发往错误的端点，`resolveModel` 不作推测。
  const other = (port: number) => ({
    kind: 'openai_chat_completions',
    apiKey: 'sk-fake',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    models: { 'shared-model': {} },
  })
  const config = {
    ...TWO_MODELS,
    providers: { ...TWO_MODELS.providers, a: other(1), b: other(2) },
  }
  const before = requestedModels.length
  const r = await run(['exec', '--model', 'shared-model', '汇报一次'], config)
  expect(r.code).toBe(2)
  expect(r.err).toContain('无法确定模型 shared-model 所属的接口')
  expect(r.db).toBe(false)
  expect(requestedModels.length).toBe(before)
})
