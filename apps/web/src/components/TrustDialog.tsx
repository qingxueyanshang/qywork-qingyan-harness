import { createResource, createSignal, Show } from 'solid-js'
import { loadWorkspace, trustWorkspace, workspace } from '../lib/store/index.ts'
import { ConfirmDialog } from './ConfirmDialog.tsx'

/**
 * 项目信任。
 *
 * **只在真有待决定的事时出现**：这个项目的 `.agents/mcp.json` 声明了 server，
 * 而它还没被信任。绝大多数项目没有这个文件，从头到尾看不到这个框——所以它不是给
 * 「添加项目」加的一步，是那一步里唯一一种需要人拍板的情形。
 *
 * **挡的是什么**：`.agents/` 跟着仓库走，克隆下来就带着。没有这一问，把别人的仓库
 * 设成项目就等于同意执行它声明的命令，中间没有一步经过用户。
 *
 * **取消不落盘。** 只在本次运行里记住别再问，重开应用会再问一次。落一份「拒绝过」的
 * 名单就是第二本账，而这个决定本来就还没有做出。取消信任改 `config.json` 的
 * `trustedWorkspaces`。
 *
 * **状态与控制分开**：这里只负责问一次。「哪几条因为没信任而没启动」是状态，
 * 挂在会看到它的那一层（设置 → MCP）。
 */
export function TrustDialog() {
  /** 本次运行里已经问过的项目 id。 */
  const [asked, setAsked] = createSignal<string[]>([])
  const [detail, { refetch }] = createResource(
    () => workspace()?.id,
    () => loadWorkspace(),
  )

  const pending = () => detail()?.pendingTrust ?? []
  const open = () => {
    const id = workspace()?.id
    return id !== undefined && pending().length > 0 && !asked().includes(id)
  }

  const dismiss = () => {
    const id = workspace()?.id
    if (id !== undefined) setAsked((v) => [...v, id])
  }

  const accept = async () => {
    dismiss()
    // 失败也不再追问：它已经作为一条通知端出来了，把同一个框再弹一次没有新信息。
    await trustWorkspace(true).catch(() => {})
    void refetch()
  }

  return (
    <Show when={open()}>
      <ConfirmDialog
        open
        title={`信任「${workspace()?.name ?? ''}」？`}
        message={`这个项目的 .agents/mcp.json 声明了 ${pending().join('、')}，信任后它们会作为本机进程启动。`}
        confirmLabel="信任"
        onConfirm={() => void accept()}
        onCancel={dismiss}
      />
    </Show>
  )
}
