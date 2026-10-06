/**
 * MCP。
 *
 * 界面需要显示每个 server 的连接状态、提供的工具与失败原因。MCP 最需要显示失败：
 * 只提供 `prompts` 的 server 会连接成功、握手成功、注册 0 个工具且不报任何错误，
 * 界面上表现为已配置但没有任何效果。
 *
 * `mcp.json` 决定模型获得哪些工具，因此它在 `auto` 下是受保护路径，`write_file` / `edit_file` 拒绝写入。
 * 导入接口与模型专用工具共用 runtime 的配置写入实现，不能各自解析与合并。
 *
 * **导入现有配置。** `/api/mcp/import` 读取本机上的一个文件，把其中的 server 合并到本层。用户通常
 * 从其他 MCP 客户端整段复制配置，要求先另存为文件再指定路径：同名冲突可以在此报告。
 */

import { readFile } from 'node:fs/promises'
import { parseMcpConfig } from '@qywork/mcp'
import { MCP_CONFIG, mergeMcpServers } from '@qywork/runtime'
import { type ApiHandler, json } from './types.ts'

/** 只有项目层与全局层可写。内置层随程序发布，写入的内容在下次升级时丢失。 */
function writableScope(raw: string | null): 'project' | 'global' | null {
  if (raw === null || raw === 'project') return 'project'
  if (raw === 'global') return 'global'
  return null
}

export const handleMcpApi: ApiHandler = async (url, req, d) => {
  const p = url.pathname

  /**
   * 已连接的 server 及其提供的工具。
   *
   * 失败项与成功项一并返回：连接失败的 server 是用户最需要看到的部分。
   * `unsupported` 同样返回：该字段用于消除「握手成功但没有任何工具」这种静默失败。
   */
  if (p === '/api/mcp' && req.method === 'GET') {
    /*
     * 使用引用计数，与 release 配对。直接调用 `loadExtensions` 会为每次请求启动一批新的
     * 插件与 MCP 子进程且无人关闭，每打开一次该页面即泄漏一套。异常路径同样需要 release，
     * 因此使用 try/finally。与 `/api/tools` 相同。
     *
     * 另一作用：此处返回的必须是模型持有的同一份扩展。另行启动一份时，配置刚修改后
     * 页面显示的连接状态会与模型持有的不一致。
     */
    const { acquireExtensions, releaseExtensions } = await import('@qywork/runtime')
    const ext = await acquireExtensions(d.workspaceRoot)
    try {
      const config = ext.mcpConfig
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
        /** 已配置但本次未连接的 server 同样列出，否则它们在界面上消失。 */
        configured: Object.keys(config.servers).map((name) => ({
          name,
          scope: config.scopeOf[name] ?? 'project',
        })),
        error: config.error,
      })
    } finally {
      await releaseExtensions(ext)
    }
  }

  /**
   * 从本机上的现有配置中合并 server。
   *
   * 用户通常从其他 MCP 客户端整段复制配置，文件的键名可能是 `servers`，
   * 也可能是 `mcpServers`；`parseMcpConfig` 两者都识别，因此此处读取其解析结果，
   * 不另行识别键名。
   *
   * 同名不覆盖：本层已有同名 server 时整个请求返回 409 并列出名称，
   * 不从中选择一个保留。覆盖会直接抹掉用户自己配置的条目，且没有任何提示。
   *
   * 写回时使用本层已在使用的键：解析器同时识别两个键但只取其中一个，
   * 且 `servers` 优先。本层原文使用 `servers` 而此处写入 `mcpServers` 时，
   * 合并进来的条目会被整体忽略，界面不报任何错误。
   */
  if (p === '/api/mcp/import' && req.method === 'POST') {
    const scope = writableScope(url.searchParams.get('scope'))
    if (!scope) return json({ error: 'bad request', message: '只能写入项目层或全局层' }, 400)
    const body = (await req.json().catch(() => null)) as { path?: string } | null
    const src = body?.path?.trim()
    if (!src) return json({ error: 'bad request', message: '缺少文件路径' }, 400)

    const raw = await readFile(src, 'utf8').catch(() => null)
    if (raw === null) return json({ error: 'invalid', message: `无法读取该文件：${src}` }, 422)
    const incoming = parseMcpConfig(raw)
    const names = Object.keys(incoming.servers)
    // 解析不出任何条目时拒绝：指定了错误的文件时会报告导入成功而列表不变，
    // 用户无从得知原因。`error` 中是被忽略条目的原因。
    if (incoming.error || names.length === 0) {
      return json(
        { error: 'invalid', message: incoming.error ?? '该文件中没有可用的 MCP server' },
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
    // 保存与实际连接结果一并返回。
    return json(merged)
  }

  return null
}
