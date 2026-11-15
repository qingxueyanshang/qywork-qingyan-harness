import { definePort } from '@qywork/agent'

/**
 * 插件安装端口：将工作区中已编写完成的插件目录安装到本机的插件目录。
 *
 * **为什么是端口。** 清单校验位于插件包，而插件包与 tools **同层**（依赖图中均为第 3 层），同层之间不得互相依赖。
 * 因此工具只声明形状，由装配方在更高层实现。只注入顶层会话：成员会话不应为整台机器安装插件。
 * 未注入时 `install_plugin` 不注册：无法安装插件的安装工具没有任何降级形态。
 *
 * **不询问用户。** 本产品只有两种权限模式（`auto` / `full`），没有「逐次询问」档位。
 * 安装插件与其他工具相同，执行即视为同意；校验由**清单校验**承担：形状不合法时立即拒绝，
 * 不落盘。
 *
 * **为什么分两步。** `inspect` 只返回摘要，供模型判断该目录是否为待安装的目录；
 * 安装之前实现方会**再读取一次**：两步之间模型还会执行其他步骤，目录可能已经变化。
 */
export interface PluginPort {
  /** 只检查不安装：返回目录中的清单内容。不合法时返回 `error`，不抛出异常。 */
  inspect(dir: string): Promise<{
    ok: boolean
    error?: string
    id?: string
    name?: string
    version?: string
    tools?: string[]
    permissions?: string[]
    /** 本机已安装同 id 的插件，本次安装为覆盖。 */
    replacing?: boolean
  }>
  /** 安装。`replace` 为假且已存在同 id 的插件时直接拒绝，不静默覆盖。 */
  install(dir: string, opts: { replace: boolean }): Promise<{ ok: boolean; error?: string }>
}

export const PluginPort = definePort<PluginPort>('plugins')
