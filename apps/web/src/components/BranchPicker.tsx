import { createSignal, For, onCleanup, Show } from 'solid-js'
import { ApiError } from '../lib/client.ts'
import { client, state } from '../lib/store/index.ts'
import { IconBranch, IconChevron } from './Icons.tsx'

interface Branch {
  name: string
  current: boolean
}

/**
 * 服务端那句话，不是 HTTP 信封。
 *
 * `ApiError.message` 长成 `409 /api/git/switch: {"error":"…"}`——状态码、路径、
 * 一整段 JSON 全在里面。而这里唯一要给用户看的是 git 的原话
 * （「以下文件的本地改动会被覆盖：f.txt」），`detail` 就是它。
 */
function said(e: unknown, fallback: string): string {
  if (e instanceof ApiError) return e.detail
  return e instanceof Error ? e.message : fallback
}

/**
 * 当前分支 + 切到别条。
 *
 * **这是界面上唯一一个会改用户磁盘文件的按钮。** 失败时把 git 的原话原样贴出来
 * ——本地改动会被覆盖时它列的正是哪几个文件，那句话就是用户要看的东西。
 *
 * **跑着的时候不禁用。** 文件在模型读过之后变了这件事由文件工具裁决
 * （`edit_file` 落笔前比哈希，对不上就 `stale_write` 要求重读），这里再拦一次
 * 是第二个裁决者，挡的还是用户明确要做的动作。
 *
 * 清单点开才拉：不是每次开会话都会切分支，而 `for-each-ref` 是要起进程的。
 * 每次点开都重拉一遍——分支是用户在终端里随时会加的东西，缓存住的清单
 * 会让刚建好的分支不在列表里。
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
      setError(said(e, '分支列表拉不到'))
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
      // 新分支名由服务端切完当场广播，这里不自己写 `state.git`——
      // 两处都写就是两本账，而广播那一份才是真的（切失败时它不会来）。
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
      <button class="mode-chip" type="button" title="切换分支" onClick={toggle}>
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
          {/* 报错在列表**下面**：追加在上面会把用户刚点过的那一行整体推下去。
              浮层往下弹也是为了这个（css 里那段注释）。 */}
          <Show when={error()}>
            <div class="branch-error">{error()}</div>
          </Show>
        </div>
      </Show>
    </div>
  )
}
