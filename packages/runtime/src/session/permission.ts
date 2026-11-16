/** 权限裁决：本会话工具调用的 `requestPermission`。 */

import { decideCommand, type PermissionVerdict } from '@qywork/agent'
import type { ConversationId } from '@qywork/core'
import { permissionModeOf } from '@qywork/store'
import { workspacePythonReady } from '../environment.ts'
import type { SessionState } from './types.ts'

/**
 * 授权裁决。只有两种模式，不弹出确认框。
 *
 * `full` 模式下仍保留的只有凭证剥离。`scrubEnv` 在两种模式下行为相同：它不是裁决，而是「明文
 * key 不进入子进程」这一与模式无关的事实。路径约束不在此列：`full` 的语义是「全部权限」，路径
 * 边界随之一并放开（放行时带上 `unrestrictedPaths`）。
 *
 * 只放开权限检查而保留路径层不会更安全，只会形成两套账：同一模式下
 * `run_command` 全部放行，shell 中一个 `cd` 即可离开工作区，而 `read_file` 仍被拦截；
 * 账本中有实际记录，模型随即改用 shell 读取了同一个文件
 * （会话 `cv_0msw3jst9`）。
 *
 * `auto` 模式下各类工具的处理方式。判据是该操作由谁决定，而不是代码来源：
 *
 * - 文件与网络类（read/write/delete/network）：路径已由
 *   `resolveInWorkspace` 限定，外发请求已经过 SSRF 防护，均为确定性判断，
 *   越界的调用不会到达此处。因此放行，不再额外裁决。
 * - MCP 与插件工具的调用：由用户显式配置或安装，属于知情同意，放行；
 *   不为用户自选的扩展另设第三套检查。
 * - 内置浏览器工具（`browser` 效果）：端口由装配方按本轮执行注入，
 *   参数中自报的会话、Run、工作区根一律不读取；页面归属由宿主裁决，用户手动打开的页面
 *   须由用户指定后经 `bind` 才归属本会话；上传与下载的路径与文件工具使用同一份裁决。
 *   边界均位于参数解析之前，放行。
 * - 内置桌面工具（`desktop` 效果）：端口由装配方按用户的启用开关与宿主状态注入，
 *   参数中只有端口发放的不透明目标 id，OS 句柄不会交给模型；能否操作由
 *   系统授权与宿主裁决。边界同样位于参数解析之前，放行。
 * - 声明了命令行的调用（`ToolSpec.commandLine`：`run_command`，以及写入 stdio MCP 服务的
 *   `write_mcp_server`）：命令字符串中的路径不经过参数解析，能同时绕过路径约束与 SSRF 防护，
 *   由 `decideCommand` 裁决。是否裁决取决于调用是否声明了命令行，不按工具名判断。
 */
export async function decide(
  session: Pick<SessionState, 'opts' | 'extraDirs'>,
  conversationId: ConversationId,
  call: {
    toolName: string
    args: Record<string, unknown>
    command?: string
  },
): Promise<PermissionVerdict> {
  // 每次裁决从账本读取：运行中切换模式后，下一次调用即按新模式裁决，路径范围随裁决一并给出。
  if (permissionModeOf(session.opts.store, conversationId) === 'full') {
    return { allowed: true, unrestrictedPaths: true }
  }

  if (call.command === undefined) return { allowed: true }

  const command = call.command
  // 根目录清单必须与路径层、沙箱层使用同一份。三处分别计算时，
  // 配置只在其中一层生效，且三层的报错互不相关。
  const d = decideCommand(command, {
    workspaceRoot: session.opts.workspaceRoot,
    ...(session.extraDirs.length ? { additionalDirectories: session.extraDirs } : {}),
    // 命令中的相对路径以命令的工作目录为基准；取值与 `run_command` 解析 `cwd` 参数的方式相同。
    cwd: String(call.args.cwd ?? '.'),
    workspacePython: workspacePythonReady(session.opts.workspaceRoot),
  })
  if (d.kind === 'allow') return { allowed: true }
  /*
   * 该文本是模型在 `auto` 模式下能取得的唯一信号，因此必须给出正当的处理方式。
   *
   * 不要写成「换一条不执行该操作的命令」：这等于引导模型绕过规则，`rm -rf ~/x` 被拦截后
   * 会被改写为 `python -c "import shutil; shutil.rmtree(...)"`，后者不在
   * `HARD_DENY` 表中即被放行。规则拦截的是操作本身，而不是某种写法。
   *
   * 不附带 scope：`execute:<目标>` 对模型没有信息量，模型不了解 scope 的含义，
   * 而命令正是它刚刚发出的。
   */
  return {
    allowed: false,
    reason:
      `权限规则拒绝执行此命令：${d.reason}。当前为「自动审批」模式。` +
      `需要该操作时用 write_todos 把该项标为 blocked（user_only），由用户改为「完全访问」；不要以其他写法执行同一操作。`,
  }
}
