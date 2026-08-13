/**
 * MCP。
 *
 * 在此之前 MCP 只有 `/api/plugins` 顺带回的一个名字数组：连上了几个、每个给了
 * 哪些工具、失败的那个为什么失败，界面上一概看不到。而 MCP 恰恰是**最需要看到
 * 失败**的一块——一个只提供 `prompts` 的 server 会连上、握手成功、注册 0 个工具、
 * 不报任何错，用户看到的是「配了但什么都没发生」。
 *
 * ## 边界必须写在页面上
 *
 * `mcp.json` 决定模型拿到哪些工具。agent 用 shell 写它等于自我提权，所以
 * `.agents/` 在写路径上是受保护目录（`tools/src/paths.ts` 的 `PROTECTED_DIRS`）。
 * 这条不是解释，是用户据以决定要不要在这里加 server 的事实（B7 的例外条款）。
 *
 * ## 原文编辑而不是表单
 *
 * server 的配置形状按 transport 分好几种（stdio 要 command/args/env，http 要 url
 * 和 headers），做成表单要么盖不全要么长成一个通用 JSON 编辑器的劣化版。
 * 照 `/api/team/raw` 的做法：给原文、存原文，解析结果单独回。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { loadScopedMcpConfig, MCP_CONFIG, MCP_FILE } from '@qywork/runtime'
import { type Scope, scopeDir, scopeRoots } from '@qywork/tools'
import { type ApiHandler, json } from './types.ts'

/** 只有用户层和全局层可写。内置随程序发布，写进去下次升级就没了。 */
function writableScope(raw: string | null): Scope | null {
  if (raw === null || raw === 'user') return 'user'
  if (raw === 'global') return 'global'
  return null
}

export const handleMcpApi: ApiHandler = async (url, req, d) => {
  const p = url.pathname

  /**
   * 已连上的 server 与它们给出的工具。
   *
   * 失败项和成功项一起回：连不上的那个恰恰是用户最需要看到的部分。
   * `unsupported` 也要回——它存在的意义就是消灭「握手成功但一个工具都没有」
   * 这种静默失败。
   */
  if (p === '/api/mcp' && req.method === 'GET') {
    const { loadExtensions } = await import('@qywork/runtime')
    const ext = await loadExtensions(d.workspaceRoot)
    const config = await loadScopedMcpConfig(d.workspaceRoot)
    return json({
      configPath: MCP_CONFIG,
      files: config.files,
      servers: ext.mcp.servers.map((s) => ({
        name: s.name,
        scope: config.scopeOf[s.name] ?? 'user',
        serverInfo: s.serverInfo,
        protocolVersion: s.protocolVersion,
        unsupported: s.unsupported,
        tools: s.tools.map((t) => ({ name: t.name, description: t.description ?? '' })),
      })),
      failures: ext.mcp.failures,
      /** 配好了但这一轮没连上的那些，也要列出来——否则它们凭空消失。 */
      configured: Object.keys(config.servers).map((name) => ({
        name,
        scope: config.scopeOf[name] ?? 'user',
      })),
      error: config.error,
    })
  }

  if (p === '/api/mcp/raw') {
    const scope = writableScope(url.searchParams.get('scope'))
    if (!scope) return json({ error: 'bad request', message: '只能读写用户层或全局层' }, 400)
    const dir = scopeDir(scopeRoots(d.workspaceRoot), scope, '')
    if (dir === null) return json({ error: 'bad request', message: '这一层不可写' }, 400)
    const file = join(dir, MCP_FILE)

    if (req.method === 'GET') {
      const raw = await readFile(file, 'utf8').catch(() => null)
      // 不存在不是错误：回 `exists: false` 加一个空串，编辑器直接就能写第一条。
      return json({ path: file, exists: raw !== null, raw: raw ?? '', scope })
    }

    if (req.method === 'PUT') {
      const body = (await req.json().catch(() => null)) as { raw?: string } | null
      const raw = body?.raw
      if (typeof raw !== 'string') return json({ error: 'bad request', message: '缺少 raw' }, 400)
      // 校验先于落盘：存进一份解析不了的 JSON，下一次启动会变成一条 error，
      // 而那时候用户已经不记得自己刚才改了什么。
      try {
        JSON.parse(raw)
      } catch (err) {
        return json({ error: 'invalid', message: `JSON 解析失败：${String(err)}` }, 422)
      }
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, raw.endsWith('\n') ? raw : `${raw}\n`, 'utf8')
      // 改完要重连才生效。**说出来**——不说的话用户会以为存了就有了。
      return json({ ok: true, path: file, restartRequired: true })
    }
  }

  return null
}
