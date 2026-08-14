import { createResource, For, Show } from 'solid-js'
import { client } from '../../lib/store/index.ts'
import { LoadState } from './LoadState.tsx'

/**
 * 这个 agent 会做什么。
 *
 * ## 它是分类轴的消费者
 *
 * `ToolCategory` 那条轴（七个大类 + 类内的功能方向）如果没有这一页，就是
 * C1 第 1 款的死链路：注册期校验着、每个工具都打了标、没有任何人读。
 * 参照实现那边正是这个下场——魔盒的 `taxonomy()` docstring 自己写着
 * 「本函数不再有渲染消费者」。
 *
 * ## 只有中文，没有工具名
 *
 * 列的是**用途**（`summary`），按「大类 → 功能方向」两层分组。
 * `read_file` 这类工具名是机制字段，只在 CLI 里露面——桌面端一律中文。
 *
 * 这也决定了这一页回答的问题：不是「装了哪些工具」（那是给开发者看的清单），
 * 而是「它能替我做什么」。
 */

/** 大类的中文名。**后端只下发类目 id，文案在前端**——见 `events.ts` 那条口径。 */
const CATEGORY_LABELS: Record<string, string> = {
  files: '文件与草稿',
  code: '脚本与代码',
  web: '网络',
  knowledge: '记忆与技能',
  planning: '计划与任务',
  session: '会话管理',
  external: '外部扩展',
}

interface ToolRow {
  category: string
  facet: string
  summary: string
}

export function ToolsSettings() {
  const [data, { refetch }] = createResource(() =>
    client.api<{ tools: ToolRow[]; mcpServers: string[] }>('/api/tools'),
  )

  /** 后端已按类目→方向→用途排好序，这里只做分组，不再重排。 */
  const groups = () => {
    const out: { category: string; facets: { facet: string; rows: ToolRow[] }[] }[] = []
    for (const row of data()?.tools ?? []) {
      let g = out[out.length - 1]
      if (!g || g.category !== row.category) {
        g = { category: row.category, facets: [] }
        out.push(g)
      }
      let f = g.facets[g.facets.length - 1]
      if (!f || f.facet !== row.facet) {
        f = { facet: row.facet, rows: [] }
        g.facets.push(f)
      }
      f.rows.push(row)
    }
    return out
  }

  return (
    <Show when={data()} fallback={<LoadState error={data.error} onRetry={() => void refetch()} />}>
      <For each={groups()}>
        {(g) => (
          <section class="settings-block">
            <h3 class="settings-block-head">{CATEGORY_LABELS[g.category] ?? g.category}</h3>
            <div class="setting-rows">
              <For each={g.facets}>
                {(f) => (
                  <div class="setting-row stack">
                    <div class="setting-row-text">
                      <span class="setting-row-label">{f.facet}</span>
                    </div>
                    <ul class="tool-uses">
                      <For each={f.rows}>{(r) => <li>{r.summary}</li>}</For>
                    </ul>
                  </div>
                )}
              </For>
            </div>
          </section>
        )}
      </For>

      {/* 能力边界，不折叠也不淡化（B7 例外条款）：MCP 的工具清单要连上 server
          才知道，这一页没有连。不写这句的话，装了 MCP 的用户会以为上面就是全部。 */}
      <Show when={(data()?.mcpServers.length ?? 0) > 0}>
        <p class="settings-page-note">
          另外接着 {data()?.mcpServers.length} 个 MCP server。它们提供哪些工具要连上之后才知道，
          这一页不连，所以没有列在上面。
        </p>
      </Show>
    </Show>
  )
}
