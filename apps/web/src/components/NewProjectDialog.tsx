import { createEffect, createSignal, onCleanup, Show } from 'solid-js'
import { addWorkspace, pickWorkspace } from '../lib/store/index.ts'
import { IconFolder, IconPlus } from './Icons.tsx'

/**
 * 新建 work。
 *
 * ## 为什么是弹窗，不是直接开目录选择器
 *
 * 上一版点一下就弹系统目录选择器，于是「项目」被迫等于「一个已经存在的目录」——
 * 名字只能取目录名，也没法先建一个空的开始干活。这里把两件事分开：
 * **名字是项目的，路径是它落在哪**。
 *
 * ## 源文件夹可以留空
 *
 * 留空就在 `~/.qywork/workspaces/<名称>/` 建一个新的。会话挂的是项目 id，
 * 不是路径——所以以后改名字不会丢会话。
 *
 * ## 选目录只有桌面端有
 *
 * 系统目录选择器是外壳能力，浏览器拿不到。那边这颗按钮不渲染（B5），
 * 但输入名字建默认工作区仍然可用——不是整个功能都没了。
 */
export function NewProjectDialog(props: {
  open: boolean
  /** 桌面外壳才有系统目录选择器。 */
  canPickFolder: boolean
  onCreated: (rootPath: string) => void
  onClose: () => void
}) {
  const [name, setName] = createSignal('')
  const [folder, setFolder] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  // 每次打开都是干净的一张表：留着上一次的输入会让人以为它记住了什么。
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

  /** 选了文件夹而没填名字时，名字就是那个文件夹名——不逼用户填两遍。 */
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
      const res = await addWorkspace({
        ...(folder() ? { path: folder() as string } : {}),
        ...(name().trim() ? { name: name().trim() } : {}),
      })
      props.onCreated(res.workspace.rootPath)
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
              placeholder={folder() ? '留空就用文件夹名' : '例如：青学研上'}
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
                    fallback={<span class="np-hint">在这台机器上会建一个新文件夹</span>}
                  >
                    <button class="np-pick" type="button" onClick={() => void pick()}>
                      <IconPlus size={14} />
                      选一个本机文件夹
                    </button>
                  </Show>
                  {/* 边界声明留全（B7）：不写的话「留空会发生什么」没有任何提示。 */}
                  <span class="np-hint">留空就在 qywork 的数据目录下新建一个</span>
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

          {/* 失败要有终态：名字不合法、目录建不出来，都在这里说出来。 */}
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
