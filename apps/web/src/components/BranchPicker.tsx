import { createSignal, For, onCleanup, Show } from 'solid-js'
import { ApiError } from '../lib/client.ts'
import { client, state } from '../lib/store/index.ts'
import { IconBranch, IconChevron } from './Icons.tsx'

interface Branch {
  name: string
  current: boolean
}

/**
 * 取服务端返回的错误原文，而不是 HTTP 错误的完整包装。
 *
 * `ApiError.message` 的形式为 `409 /api/git/switch: {"error":"…"}`，包含状态码、路径与
 * 整段 JSON。此处需要显示给用户的只有 git 的原文
 * （「以下文件的本地改动会被覆盖：f.txt」），即 `detail`。
 */
function said(e: unknown, fallback: string): string {
  if (e instanceof ApiError) return e.detail
  return e instanceof Error ? e.message : fallback
}

/**
 * 显示当前分支，并切换到其他分支。
 *
 * **这是界面上唯一会修改用户磁盘文件的按钮。** 切换失败时显示一句说明，
 * 其中列出阻止切换的文件，这是用户唯一可以处理的位置（服务端的 `refusal`）。
 *
 * **运行期间不禁用。** 文件在模型读取之后是否变化由文件工具裁决
 * （`edit_file` 写入前比对哈希，不一致时以 `stale_write` 要求重新读取），此处再拦截一次
 * 会形成第二个裁决者，拦截的又是用户明确要执行的操作。
 *
 * 分支列表在点开时才获取：并非每次打开会话都会切换分支，而 `for-each-ref` 需要启动进程。
 * 每次点开都重新获取：用户随时可能在终端中新建分支，缓存的列表
 * 会缺少刚建好的分支。
 */
export function BranchPicker() {
  const [open, setOpen] = createSignal(false)
  const [list, setList] = createSignal<Branch[]>([])
  const [error, setError] = createSignal<string | null>(null)

  const toggle = async () => {
    if (open()) {
      setOpen(false)
      return
    }
    setOpen(true)
    setError(null)
    try {
      const r = await client.api<{ branches: Branch[] }>('/api/git/branches')
      setList(r.branches)
    } catch (e) {
      setList([])
      setError(said(e, '无法加载分支列表'))
    }
  }

  const pick = async (name: string) => {
    setError(null)
    try {
      await client.api('/api/git/switch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ branch: name }),
      })
      // 新分支名由服务端在切换完成后立即广播，此处不自行写入 `state.git`：
      // 两处都写入会形成两本账，而广播的值才是权威（切换失败时不会广播）。
      setOpen(false)
    } catch (e) {
      setError(said(e, '切换失败'))
    }
  }

  const onDocClick = (e: MouseEvent) => {
    if (!(e.target as HTMLElement).closest('.branch-picker')) setOpen(false)
  }
  document.addEventListener('click', onDocClick)
  onCleanup(() => document.removeEventListener('click', onDocClick))

  return (
    <div class="branch-picker">
      <button class="mode-chip" type="button" data-tip="切换分支" onClick={toggle}>
        <IconBranch size={13} />
        <span class="truncate">{state.git?.branch}</span>
        <IconChevron size={11} dir={open() ? 'up' : 'down'} />
      </button>

      <Show when={open()}>
        <div class="branch-menu" role="listbox">
          <For each={list()}>
            {(b) => (
              <button
                class="branch-item"
                classList={{ active: b.current }}
                type="button"
                role="option"
                aria-selected={b.current}
                disabled={b.current}
                onClick={() => void pick(b.name)}
              >
                <span class="truncate">{b.name}</span>
              </button>
            )}
          </For>
          {/* 报错显示在列表下方：显示在上方会把用户刚点击的行整体下推。
              浮层向下弹出也是出于同一原因（见 CSS 中的对应注释）。 */}
          <Show when={error()}>
            <div class="branch-error">{error()}</div>
          </Show>
        </div>
      </Show>
    </div>
  )
}
