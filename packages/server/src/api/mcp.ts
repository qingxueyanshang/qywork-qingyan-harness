/**
 * MCP。
 *
 * 在此之前 MCP 只有 `/api/plugins` 附带回的一个名字数组：连上了几个、每个给了
 * 哪些工具、失败的那个为什么失败，界面上一概看不到。而 MCP 是**最需要看到
 * 失败**的一块——一个只提供 `prompts` 的 server 会连上、握手成功、注册 0 个工具、
 * 不报任何错，用户看到的是「配了但什么都没发生」。
 *
 * `mcp.json` 决定模型拿到哪些工具，所以它在 `auto` 下是受保护路径，`write_file` / `edit_file` 拒写。
 * 导入接口与模型专用工具共用 runtime 的配置写入实现，不能各自解析和合并一遍。
 *
 * **导入一份现成的配置。** `/api/mcp/import` 读本机上一个文件，把里面的 server 并进本层。用户通常是
 * 从别的 MCP 客户端整段拷过来的，让他先另存成文件再指过来：同名冲突这里能报出来。
 */

import { readFile } from 'node:fs/promises'
import { parseMcpConfig } from '@qywork/mcp'
import {
  isWorkspaceTrusted,
  loadConfig,
  loadScopedMcpConfig,
  MCP_CONFIG,
  mergeMcpServers,
} from '@qywork/runtime'
import { type ApiHandler, json } from './types.ts'

/** 只有项目层和全局层可写。内置随程序发布，写进去下次升级就没了。 */
function writableScope(raw: string | null): 'project' | 'global' | null {
  if (raw === null || raw === 'project') return 'project'
  if (raw === 'global') return 'global'
  return null
}

export const handleMcpApi: ApiHandler = async (url, req, d) => {
  const p = url.pathname

  /**
   * 已连上的 server 与它们给出的工具。
   *
   * 失败项和成功项一起回：连不上的那个是用户最需要看到的部分。
   * `unsupported` 也要回——它存在的意义就是消灭「握手成功但一个工具都没有」
   * 这种静默失败。
   */
  if (p === '/api/mcp' && req.method === 'GET') {
    /*
     * **走引用计数，配对 release。** 直接 `loadExtensions` 会给每一次请求新起一批
     * 插件与 MCP 子进程，而且没有人关——开一次这一页就漏一套。异常路径也要 release，
     * 所以是 try/finally。同 `/api/tools`。
     *
     * 另一层作用：这里回的必须就是**模型手里那一份**。现起一份的话，信任刚打开时
     * 这一页会显示「已连上」，而模型持有的仍是加载时那份，两个界面互相打脸。
     */
    const { acquireExtensions, releaseExtensions } = await import('@qywork/runtime')
    const ext = await acquireExtensions(d.workspaceRoot)
    try {
      const config = await loadScopedMcpConfig(d.workspaceRoot)
      return json({
        configPath: MCP_CONFIG,
        files: config.files,
        servers: ext.mcp.servers.map((s) => ({
          name: s.name,
          scope: config.scopeOf[s.name] ?? 'project',
          serverInfo: s.serverInfo,
          protocolVersion: s.protocolVersion,
          unsupported: s.unsupported,
          tools: s.tools.map((t) => ({ name: t.name, description: t.description ?? '' })),
        })),
        failures: ext.mcp.failures,
        /** 配好了但这一轮没连上的那些，也要列出来——否则它们凭空消失。 */
        configured: Object.keys(config.servers).map((name) => ({
          name,
          scope: config.scopeOf[name] ?? 'project',
        })),
        error: config.error,
        /**
         * 项目层要先授权才加载。未授权时项目层的 server 只出现在 `configured` 里，
         * `servers` 一条都没有——界面必须能说出这是为什么，否则用户看到的是
         * 「配了但什么都没发生」。
         */
        trusted: isWorkspaceTrusted(await loadConfig(), d.workspaceRoot),
      })
    } finally {
      releaseExtensions(d.workspaceRoot)
    }
  }

  /**
   * 从本机上一份现成的配置里把 server 并进来。
   *
   * 用户通常是从别的 MCP 客户端整段拷过来的，那份文件的键名可能是 `servers`
   * 也可能是 `mcpServers`——`parseMcpConfig` 两个都认，所以这里读它的解析结果，
   * 不自己再认一遍键名。
   *
   * **同名不覆盖**：本层已经有同名 server 时整个请求回 409 并把名字列出来，
   * 而不是挑一个赢家。覆盖会把用户自己配好的那份直接抹掉，且没有任何提示。
   *
   * **写回时用本层已经在用的那个键**：解析器同时认两个键但**只取一份**，
   * 且 `servers` 优先。本层原文用 `servers` 而这里往 `mcpServers` 里写的话，
   * 并进来的这几条会被整份忽略，界面上什么都不报。
   */
  if (p === '/api/mcp/import' && req.method === 'POST') {
    const scope = writableScope(url.searchParams.get('scope'))
    if (!scope) return json({ error: 'bad request', message: '只能写项目层或全局层' }, 400)
    const body = (await req.json().catch(() => null)) as { path?: string } | null
    const src = body?.path?.trim()
    if (!src) return json({ error: 'bad request', message: '缺少文件路径' }, 400)

    const raw = await readFile(src, 'utf8').catch(() => null)
    if (raw === null) return json({ error: 'invalid', message: `读不到这个文件：${src}` }, 422)
    const incoming = parseMcpConfig(raw)
    const names = Object.keys(incoming.servers)
    // 一条都解析不出来就拒绝：指错文件会「导入成功」然后列表一条不变，
    // 而用户完全无从知道为什么。`error` 里装的是被忽略的那几条的原因。
    if (names.length === 0) {
      return json(
        { error: 'invalid', message: incoming.error ?? '这个文件里没有能用的 MCP server' },
        422,
      )
    }

    const merged = await mergeMcpServers(d.workspaceRoot, scope, incoming.servers)
    if (!merged.ok) {
      return json(
        {
          error: merged.kind,
          message: merged.error,
          ...(merged.names ? { names: merged.names } : {}),
        },
        merged.kind === 'conflict' ? 409 : 422,
      )
    }
    // 同 PUT：改完要重连才生效，说出来。
    return json(merged)
  }

  return null
}
