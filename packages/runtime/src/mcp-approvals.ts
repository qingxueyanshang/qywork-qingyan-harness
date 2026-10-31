/**
 * 项目层 MCP 服务的启动确认。
 *
 * 项目层配置位于仓库内（`.agents/mcp.json`），其内容可能来自仓库作者或一次 `git pull`；读取到即启动，
 * 等于以用户权限运行他人写入的命令。因此项目层的服务只有在用户确认过其当前内容之后才启动。
 *
 * 确认记录保存在用户一侧（`~/.qywork/mcp-approvals.json`），按「项目根 → 服务名 → 内容摘要」存放。
 * 不要放进仓库：仓库内的记录可以由仓库自己写入，等于由它替自己确认。内容改变后摘要不符，回到待确认。
 *
 * 经 qywork 写入的项目层服务（设置页新增与导入、`write_mcp_server`、`move_mcp_server`）在写入时一并确认：
 * 写入由用户或用户委托的模型发起，auto 下其命令已经过 `decideCommand`。
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { McpConfig } from '@qywork/mcp'
import { normalizeWorkspaceRoot } from '@qywork/store'
import { globalScopeRoot, withFileLocks } from '@qywork/tools'

type Approvals = Record<string, Record<string, string>>
type McpServerSpec = McpConfig['servers'][string]

function approvalsPath(): string {
  return join(globalScopeRoot(), 'mcp-approvals.json')
}

/** 键按字典序排列后的 JSON：同一份配置无论键的书写顺序如何，摘要都相同。 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function specDigest(spec: McpServerSpec): string {
  return createHash('sha256').update(canonical(spec)).digest('hex')
}

/**
 * 读取确认记录。文件不存在时为空；无法解析时同样按空处理并返回原因：此时项目层服务全部待确认，
 * 不会因记录损坏而启动未确认的命令。
 */
export async function readApprovals(): Promise<{ approvals: Approvals; error: string | null }> {
  const path = approvalsPath()
  const raw = await readFile(path, 'utf8').catch((err: NodeJS.ErrnoException) =>
    err.code === 'ENOENT' ? null : Promise.reject(err),
  )
  if (raw === null) return { approvals: {}, error: null }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('顶层不是对象')
    return { approvals: parsed as Approvals, error: null }
  } catch (err) {
    return {
      approvals: {},
      error: `MCP 启动确认记录无法解析，项目层服务均按未启用处理：${err instanceof Error ? err.message : String(err)}。文件：${path}`,
    }
  }
}

export function isApproved(
  approvals: Approvals,
  workspaceRoot: string,
  name: string,
  spec: McpServerSpec,
): boolean {
  return approvals[normalizeWorkspaceRoot(workspaceRoot)]?.[name] === specDigest(spec)
}

/** 记录本项目这些服务的当前内容已经确认。写入为「临时文件 + 改名」，中途失败不留下半个文件。 */
export async function approveMcpServers(
  workspaceRoot: string,
  servers: Record<string, McpServerSpec>,
): Promise<void> {
  const path = approvalsPath()
  await withFileLocks([path], async () => {
    const { approvals } = await readApprovals()
    const root = normalizeWorkspaceRoot(workspaceRoot)
    const entry = { ...(approvals[root] ?? {}) }
    for (const [name, spec] of Object.entries(servers)) entry[name] = specDigest(spec)
    approvals[root] = entry
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${crypto.randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(approvals, null, 2)}\n`, 'utf8')
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true })
    }
  })
}
