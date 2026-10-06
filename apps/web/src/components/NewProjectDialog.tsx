import { createEffect, createSignal, onCleanup, Show } from 'solid-js'
import { holdOverlay, pickWorkspace, type WorkspaceInput } from '../lib/store/index.ts'
import { IconFolder, IconPlus } from './Icons.tsx'

/**
 * 新建 work。
 *
 * **使用弹窗，而不是直接打开目录选择器。** 点击后直接弹出系统目录选择器时，「项目」只能等于「一个已经
 * 存在的目录」：名称只能取目录名，也无法先新建空目录再开始。此处把两件事分开：**名称属于项目，
 * 路径表示项目所在位置**。
 *
 * **源文件夹可以留空。** 留空时在 `~/.qywork/workspaces/<名称>/` 新建目录。会话关联的是项目 id，
 * 而不是路径，因此日后修改名称不会丢失会话。
 *
 * **只有桌面端可以选择目录。** 系统目录选择器是外壳能力，浏览器无法调用。浏览器端不渲染该按钮（B5），
 * 但输入名称新建默认工作区仍然可用。
 */
export function NewProjectDialog(props: {
  open: boolean
  /** 桌面外壳才有系统目录选择器。 */
  canPickFolder: boolean
  onCreate: (input: WorkspaceInput) => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = createSignal('')
  const [folder, setFolder] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  // 内置浏览器页是原生子视图，渲染在所有 DOM 之上；浮层打开时需先将其移出可视区。
  holdOverlay(() => props.open)

  // 每次打开都使用空白表单：保留上一次的输入会被误认为弹窗记住了某些设置。
  createEffect(() => {
    if (props.open) {
      setName('')
      setFolder(null)
      setError(null)
      setBusy(false)
    }
  })

  createEffect(() => {
    if (!props.open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        props.onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    onCleanup(() => window.removeEventListener('keydown', onKey))
  })

  /** 选择了文件夹而未填写名称时，名称取该文件夹名，无需用户重复填写。 */
  const effectiveName = () =>
    name().trim() || (folder() ? (folder() as string).split(/[/\\]/).pop() : '')

  const pick = async () => {
    setError(null)
    try {
      const picked = await pickWorkspace()
      // 取消不是错误。
      if (picked) setFolder(picked)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const create = async () => {
    setError(null)
    setBusy(true)
    try {
      await props.onCreate({
        ...(folder() ? { path: folder() as string } : {}),
        ...(name().trim() ? { name: name().trim() } : {}),
      })
      props.onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Show when={props.open}>
      <button class="backdrop-close" type="button" aria-label="取消" onClick={props.onClose} />
      <div class="sheet-backdrop pass-through">
        <div class="new-project" role="dialog" aria-modal="true" aria-label="新建 work">
          <h2 class="confirm-title">新建 work</h2>

          <label class="np-field">
            <span class="np-label">项目名称</span>
            <input
              class="np-input"
              type="text"
              value={name()}
              placeholder={folder() ? '留空则使用文件夹名' : '例如：青学研上'}
              onInput={(e) => setName(e.currentTarget.value)}
            />
          </label>

          <div class="np-field">
            <span class="np-label">源文件夹</span>
            <Show
              when={folder()}
              fallback={
                <div class="np-folder empty">
                  <Show
                    when={props.canPickFolder}
                    fallback={<span class="np-hint">在本机新建文件夹</span>}
                  >
                    <button class="np-pick" type="button" onClick={() => void pick()}>
                      <IconPlus size={14} />
                      选择本机文件夹
                    </button>
                  </Show>
                  {/* 边界声明完整保留（B7）：不写时「留空会怎样」没有任何提示。 */}
                  <span class="np-hint">留空则在 qywork 数据目录下新建文件夹</span>
                </div>
              }
            >
              {(f) => (
                <div class="np-folder">
                  <IconFolder size={15} />
                  <span class="np-path">{f()}</span>
                  <button class="np-clear" type="button" onClick={() => setFolder(null)}>
                    改用新建
                  </button>
                </div>
              )}
            </Show>
          </div>

          {/* 失败必须有终态：名称不合法、目录无法创建，都在此处显示。 */}
          <Show when={error()}>{(e) => <p class="np-error">{e()}</p>}</Show>

          <div class="confirm-actions">
            <button class="btn-ghost" type="button" onClick={props.onClose}>
              取消
            </button>
            <button
              class="btn-primary"
              type="button"
              disabled={busy() || !effectiveName()}
              onClick={() => void create()}
            >
              {busy() ? '创建中…' : '创建项目'}
            </button>
          </div>
        </div>
      </div>
    </Show>
  )
}
