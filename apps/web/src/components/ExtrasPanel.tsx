import { createResource, For, Show } from 'solid-js'
import { type ExtraRow, loadExtras, setExtraEnabled, state } from '../lib/store/index.ts'

/**
 * 「这一轮用什么」——技能 / 记忆 / MCP / 插件的逐条开关。
 *
 * ## 只影响当前这一条会话
 *
 * 设置页回答「我要改什么」，这里回答「这一轮怎么跑」。所以设置页里没有开关，
 * 开关全在这儿。混在一处的话，用户在设置里关掉一个 MCP 会以为是全局关掉了，
 * 而他多半只是不想在这次任务里被它打扰。
 *
 * ## 内置层不出现
 *
 * 用户看不到内置层，也就没有开关可言。清单由服务端出，和 agent 真正加载的
 * 那份来自同一个解析——各扫一遍就会出现「这里关掉了，模型还在用」。
 */

const GROUPS: { prefix: string; title: string }[] = [
  { prefix: 'skill:', title: '技能' },
  { prefix: 'memory:', title: '记忆' },
  { prefix: 'mcp:', title: 'MCP' },
  { prefix: 'plugin:', title: '插件' },
]

export function ExtrasPanel() {
  const conversationId = () => state.activeConversation
  const [data, { mutate, refetch }] = createResource(conversationId, loadExtras)

  const toggle = (row: ExtraRow) => {
    const id = conversationId()
    if (!id) return
    const next = !row.enabled
    // 乐观：开关要立刻跟手。失败就重拉服务端那份盖回来——**权威是服务端**，
    // 本地这份只是它的回声。
    mutate((prev) =>
      prev ? prev.map((r) => (r.key === row.key ? { ...r, enabled: next } : r)) : prev,
    )
    void setExtraEnabled(id, row.key, next).catch(() => void refetch())
  }

  return (
    <div class="extras-panel">
      <Show
        when={conversationId()}
        fallback={<div class="preview-note">开始一条会话后可以在这里逐条开关</div>}
      >
        <Show when={data()}>
          {(rows) => (
            <For each={GROUPS}>
              {(g) => {
                const items = () => rows().filter((r) => r.key.startsWith(g.prefix))
                return (
                  <Show when={items().length > 0}>
                    <section class="git-section">
                      <div class="git-section-head">{g.title}</div>
                      <For each={items()}>
                        {(row) => (
                          <label class="extra-row">
                            <input
                              type="checkbox"
                              checked={row.enabled}
                              onChange={() => toggle(row)}
                            />
                            <span class="extra-label truncate">{row.label}</span>
                            {/* 全局层的条目要标出来：它在别的会话里也存在，
                                而关掉只影响这一条——不标的话两件事分不清。 */}
                            <Show when={row.scope === 'global'}>
                              <span class="scope-tag" data-scope="global">
                                全局
                              </span>
                            </Show>
                          </label>
                        )}
                      </For>
                    </section>
                  </Show>
                )
              }}
            </For>
          )}
        </Show>
      </Show>
    </div>
  )
}
