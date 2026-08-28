/**
 * MCP 配置的唯一写入实现。
 *
 * server 的导入接口和模型工具都走这里。解析使用 mcp 包的同一份解析器，作用域路径使用 tools 包的同一份
 * 根目录规则，避免界面能导入而模型写出的配置按另一套规则被忽略。
 */

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { McpConfigPort } from '@qywork/agent'
import { parseMcpConfig } from '@qywork/mcp'
import { scopeDir, scopeRoots } from '@qywork/tools'
import { MCP_FILE } from './extensions.ts'

export type WritableMcpScope = 'project' | 'global'

interface LayerDocument {
  file: string
  raw: string | null
  root: Record<string, unknown>
  key: 'servers' | 'mcpServers'
  servers: Record<string, unknown>
}

type LayerResult = { ok: true; doc: LayerDocument } | { ok: false; error: string }

function configFile(workspaceRoot: string, scope: WritableMcpScope): string {
  const root = scopeDir(scopeRoots(workspaceRoot), scope, '')
  if (root === null) throw new Error('这一层不可写')
  return join(root, MCP_FILE)
}

async function loadLayer(workspaceRoot: string, scope: WritableMcpScope): Promise<LayerResult> {
  const file = configFile(workspaceRoot, scope)
  const raw = await readFile(file, 'utf8').catch(() => null)
  if (raw === null || !raw.trim()) {
    return { ok: true, doc: { file, raw, root: {}, key: 'mcpServers', servers: {} } }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { ok: false, error: `${scope} 层的 mcp.json 解析不了，先修好它：${String(err)}` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: `${scope} 层的 mcp.json 最外层不是对象` }
  }
  const root = parsed as Record<string, unknown>
  const key = 'servers' in root ? 'servers' : 'mcpServers'
  const value = root[key] ?? {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: `${scope} 层的 ${key} 不是对象` }
  }
  return {
    ok: true,
    doc: { file, raw, root, key, servers: value as Record<string, unknown> },
  }
}

async function saveLayer(doc: LayerDocument): Promise<void> {
  doc.root[doc.key] = doc.servers
  await mkdir(dirname(doc.file), { recursive: true })
  await writeFile(doc.file, `${JSON.stringify(doc.root, null, 2)}\n`, 'utf8')
}

function validateServer(
  name: string,
  raw: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: '单个 server 配置必须是 JSON 对象' }
  }
  const parsed = parseMcpConfig(JSON.stringify({ servers: { [name]: raw } }))
  const value = parsed.servers[name]
  if (!value) return { ok: false, error: parsed.error ?? 'server 配置缺少 command 或 url' }
  if (parsed.error) return { ok: false, error: parsed.error }
  return { ok: true, value }
}

export async function mergeMcpServers(
  workspaceRoot: string,
  scope: WritableMcpScope,
  incoming: Record<string, unknown>,
): Promise<
  | { ok: true; path: string; names: string[]; restartRequired: true }
  | { ok: false; kind: 'invalid' | 'conflict'; error: string; names?: string[] }
> {
  const layer = await loadLayer(workspaceRoot, scope)
  if (!layer.ok) return { ok: false, kind: 'invalid', error: layer.error }
  const names = Object.keys(incoming)
  const clash = names.filter((name) => name in layer.doc.servers)
  if (clash.length) {
    return {
      ok: false,
      kind: 'conflict',
      error: `这一层已经有同名 server：${clash.join('、')}`,
      names: clash,
    }
  }
  for (const name of names) {
    const checked = validateServer(name, incoming[name])
    if (!checked.ok) return { ok: false, kind: 'invalid', error: `${name}：${checked.error}` }
    layer.doc.servers[name] = checked.value
  }
  await saveLayer(layer.doc)
  return { ok: true, path: layer.doc.file, names, restartRequired: true }
}

export function makeMcpConfigPort(workspaceRoot: string): McpConfigPort {
  return {
    async writeServer(input) {
      let raw: unknown
      try {
        raw = JSON.parse(input.configJson)
      } catch (err) {
        return { ok: false, error: `config_json 不是合法 JSON：${String(err)}` }
      }
      const checked = validateServer(input.name, raw)
      if (!checked.ok) return { ok: false, error: checked.error }
      const layer = await loadLayer(workspaceRoot, input.scope)
      if (!layer.ok) return { ok: false, error: layer.error }
      const replaced = input.name in layer.doc.servers
      layer.doc.servers[input.name] = checked.value
      try {
        await saveLayer(layer.doc)
        return {
          ok: true,
          path: layer.doc.file,
          replaced,
          restartRequired: true,
        }
      } catch (err) {
        return { ok: false, error: `写入 ${input.scope} 层 MCP 配置失败：${String(err)}` }
      }
    },

    async moveServer(input) {
      if (input.fromScope === input.toScope) {
        return { ok: false, error: '迁移的来源层和目标层不能相同' }
      }
      const source = await loadLayer(workspaceRoot, input.fromScope)
      if (!source.ok) return { ok: false, error: source.error }
      const target = await loadLayer(workspaceRoot, input.toScope)
      if (!target.ok) return { ok: false, error: target.error }
      if (!(input.name in source.doc.servers)) {
        return { ok: false, error: `${input.fromScope} 层没有 MCP 服务 ${input.name}` }
      }
      if (input.name in target.doc.servers) {
        return {
          ok: false,
          error: `${input.toScope} 层已有同名 MCP 服务 ${input.name}，未迁移任何配置`,
        }
      }

      target.doc.servers[input.name] = source.doc.servers[input.name]
      try {
        await saveLayer(target.doc)
      } catch (err) {
        return { ok: false, error: `写入目标层失败，原配置未改：${String(err)}` }
      }

      delete source.doc.servers[input.name]
      try {
        await saveLayer(source.doc)
      } catch (err) {
        try {
          if (target.doc.raw === null) await unlink(target.doc.file).catch(() => undefined)
          else await writeFile(target.doc.file, target.doc.raw, 'utf8')
        } catch (rollbackError) {
          return {
            ok: false,
            error: `删除来源失败，且目标回滚失败：${String(err)}；${String(rollbackError)}`,
          }
        }
        return { ok: false, error: `删除来源失败，目标已回滚，原配置仍在：${String(err)}` }
      }

      return {
        ok: true,
        fromPath: source.doc.file,
        toPath: target.doc.file,
        restartRequired: true,
      }
    },
  }
}
