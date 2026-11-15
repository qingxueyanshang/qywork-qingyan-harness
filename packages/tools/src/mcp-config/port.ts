import { definePort } from '@qywork/agent'

export interface McpActivation {
  connected: boolean
  toolNames: string[]
  failures: { server: string; reason: string }[]
  inactive: string[]
  effectiveScopes?: Record<string, 'builtin' | 'project' | 'global'>
}

/**
 * MCP 配置写入端口。
 *
 * 配置解析器位于 mcp 包，作用域路径位于 tools 包，两者同层，不能互相依赖。工具只声明动作，runtime 同时依赖
 * 二者并实现该端口。未注入端口时不注册对应工具，避免出现必然失败的入口。
 */
export interface McpConfigPort {
  writeServer(input: { name: string; configJson: string; scope: 'project' | 'global' }): Promise<{
    ok: boolean
    error?: string
    path?: string
    replaced?: boolean
    saved?: boolean
    activation?: McpActivation
  }>
  moveServer(input: {
    name: string
    fromScope: 'project' | 'global'
    toScope: 'project' | 'global'
  }): Promise<{
    ok: boolean
    error?: string
    fromPath?: string
    toPath?: string
    saved?: boolean
    activation?: McpActivation
  }>
  /**
   * 某一层中该服务将启动的命令行，供工具声明 `commandLine`。服务不存在或是 HTTP 服务时为 null。
   */
  commandLineOf(input: { name: string; scope: 'project' | 'global' }): Promise<string | null>
  /** 确认项目层中该服务的当前内容并启动它。确认记录保存在用户一侧，不写入项目文件。 */
  enableServer(input: { name: string }): Promise<{
    ok: boolean
    error?: string
    activation?: McpActivation
  }>
}

export const McpConfigPort = definePort<McpConfigPort>('mcpConfig')
