/** 扩展（插件与 MCP）提供的工具在本会话工具表中的装载。 */

import type { TokenDensity } from '@qywork/ai'
import { log } from '@qywork/core'
import { deferExternal, EXTERNAL_SCHEMA_BUDGET_TOKENS, externalSchemaTokens } from '@qywork/tools'
import { acquireExtensions } from '../extensions.ts'
import type { SessionState } from './types.ts'

/**
 * 获取扩展并将其提供的工具注册到本会话的工具表。
 *
 * 按总量分两种处理：外部工具的 schema 总量在预算内时全部以完整定义注册（省去一次往返），
 * 超出时全部以按需形态注册（`deferExternal`），完整定义由 `load_tool` 读取。阈值与实测数据见 `tools/tool-pool.ts`。
 *
 * 注册失败（重名）只跳过该工具：因一个重名的插件工具导致整个会话无法启动，
 * 代价不成比例。
 */
export async function loadExtensionTools(
  session: Pick<SessionState, 'opts' | 'registry' | 'extensions' | 'externalToolNames'>,
  density: TokenDensity,
): Promise<boolean> {
  const ext = await acquireExtensions(session.opts.workspaceRoot, (line) =>
    log.info('extensions', line),
  )
  const previous = session.extensions
  if (previous?.mcp === ext.mcp) {
    await ext.stop()
    return false
  }
  try {
    const allow = session.opts.allowedTools ? new Set(session.opts.allowedTools) : null
    const eligible = ext.toolSpecs.filter((spec) => !allow || allow.has(spec.name))
    // 角色限定了可用工具时一律以完整定义注册：角色列出的工具预期可以直接调用。
    const onDemand =
      !allow && externalSchemaTokens(eligible, density) > EXTERNAL_SCHEMA_BUDGET_TOKENS
    session.registry.replaceOwned(
      session.externalToolNames,
      onDemand ? eligible.map(deferExternal) : eligible,
    )
    session.externalToolNames = new Set(eligible.map((spec) => spec.name))
    session.extensions = ext
  } catch (error) {
    await ext.stop()
    throw error
  }
  if (previous) await previous.stop()
  for (const failure of ext.plugins.failures)
    log.warn('extensions', `插件加载失败 ${failure.dir}：${failure.reason}`)
  for (const failure of ext.mcp.failures)
    log.warn('extensions', `MCP ${failure.server}：${failure.reason}`)
  if (session.opts.allowedTools) {
    const invalid = session.opts.allowedTools.filter((name) => !session.registry.has(name))
    if (invalid.length)
      log.warn('session', `角色 allowedTools 含无效工具引用，已忽略：${invalid.join('、')}`)
  }
  return true
}
