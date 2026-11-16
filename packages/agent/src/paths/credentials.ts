/**
 * 凭证文件的判定。命令裁决（`policy.ts`）按命令全文判定，文件工具的路径解析（tools 的 `resolveInWorkspace`）
 * 按解析出的真实路径判定，两侧共用本文件的同一个函数，对同一路径给出相同的结论。内置浏览器经 file 协议
 * 读取的文件经由文件工具的路径解析判定。
 *
 * 读取的后果不比写入轻：内容进入上下文，随下一次请求发送给 provider，发送后无法撤回。模型也没有正当理由读取用户的
 * 私钥或云凭据。因此读写一律拒绝，判据是路径的写法，与位置无关：工作区与额外目录中的同名文件同样拒绝。
 *
 * 这是两道防线中的第一道。第二道是输出脱敏（tools 的 `secrets.ts`），它按 PEM 包头、`sk-`、`ghp_` 等固定形状匹配，
 * 而形状无法穷举：自建服务的 token、连接串中的密码、没有包头的 base64 私钥都无法识别。路径拦截已知位置，
 * 形状规则处理位于其他位置的凭证，例如项目中的 `.env`：它是项目文件，读取不拦截，其中的值不原样进入上下文。
 *
 * 全局数据目录（`globalScopeRoot`）中的 `config.json` 是本程序的全局配置（明文 apiKey、权限模式、额外根目录），
 * `mcp.json` 是全局 MCP 配置（server 的凭证写在 `env` 与 `headers` 中）。工作区中的 `.qy/` 与 `.agents/`
 * 是项目自身的 agent 配置，不在其中。
 */

import { globalScopeRoot, pathForms } from './global-root.ts'

/**
 * 按名称判定的凭证文件。两种分隔符都识别，不区分大小写。目录本身（末尾没有分隔符）不匹配，其中的文件匹配。
 *
 * 任何 `.qywork` 目录中的 `config.json` 与 `mcp.json` 都按名称拒绝：`QYWORK_HOME` 指向别处时，
 * 家目录中的 `~/.qywork` 仍可能保存着用户的密钥。命令中以环境变量引用全局数据目录的写法同样列出，
 * 子进程环境中保留了 `QYWORK_HOME`。
 */
const CREDENTIAL_FILE =
  /(?:\.ssh[\\/]|\bid_rsa\b|\bid_ed25519\b|\bid_ecdsa\b|\.aws[\\/]credentials|\.config[\\/]gcloud[\\/]|\.kube[\\/]config|\.npmrc\b|\.netrc\b|\.pgpass\b|\.docker[\\/]config\.json|(?:\.qywork|\$\{?QYWORK_HOME\}?|\$env:QYWORK_HOME|%QYWORK_HOME%)[\\/](?:config|mcp)\.json)/i

/** 拒绝理由中对这类文件的称呼，两侧共用。 */
export const CREDENTIAL_FILES = '凭证文件（SSH 私钥、云服务凭据、包管理器令牌或 qywork 配置）'

/** 上一次构造的全局配置文件模式及其所依据的目录。`grep` 逐个文件判定，不为每个文件重新解析目录。 */
let built: { root: string; pattern: RegExp | null } | null = null

/**
 * 全局数据目录中的两个配置文件，按该目录的实际位置判定。目录名不是 `.qywork` 时（设置了 `QYWORK_HOME`）
 * 名称规则无法识别它们；目录经链接指向别处时，文件工具判定的真实路径中同样没有目录的字面路径。
 */
function globalConfigFile(): RegExp | null {
  const root = globalScopeRoot()
  if (built?.root === root) return built.pattern
  const dirs = pathForms(root)
  const alternatives = dirs.map((dir) =>
    dir
      .replace(/[\\/]+$/, '')
      .split(/[\\/]+/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[\\\\/]+'),
  )
  const pattern =
    alternatives.length === 0
      ? null
      : new RegExp(`(?:${alternatives.join('|')})[\\\\/]+(?:config|mcp)\\.json`, 'i')
  built = { root, pattern }
  return pattern
}

/** `text` 中是否出现凭证文件的路径。`text` 是一条命令的全文或一个已解析的路径。 */
export function mentionsCredentialFile(text: string): boolean {
  return CREDENTIAL_FILE.test(text) || (globalConfigFile()?.test(text) ?? false)
}
