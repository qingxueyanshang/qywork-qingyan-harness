import { createResource, For, Show } from 'solid-js'
import { client } from '../../lib/store/index.ts'
import { LoadState } from './LoadState.tsx'

/**
 * 这个 agent 会做什么。
 *
 * ## 它是分类轴的消费者
 *
 * `ToolCategory` 那条轴（六个内置大类 + 外部扩展，各自再分功能方向）如果没有这一页，就是
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
 *
 * ## 所以底下那一栏必须在
 *
 * 既然回答的是「能做什么」，就不能只列 `ToolSpec`——**上下文压缩与版本控制
 * 这两件事用户在界面上天天看见**（会话流里的「上下文已压缩」、输入框上方的
 * 「N 个文件已更改」、侧面板的审阅改动），却一个工具都不对应：压缩由 loop
 * 按阈值触发、也可以自己按 `/compact`；git 的改动追踪在服务端轮询，模型要提交
 * 是自己跑 `git commit`。不写这一栏，这一页读起来就像这两样能力不存在。
 *
 * **它不是占位符**：每一条都指着界面上真实存在的东西，没有「以后会有」的行。
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

      <section class="settings-block">
        <h3 class="settings-block-head">不由工具承担的</h3>
        <div class="setting-rows">
          <div class="setting-row stack">
            <div class="setting-row-text">
              <span class="setting-row-label">上下文压缩</span>
            </div>
            <ul class="tool-uses">
              <li>对话逼近窗口上限时自动压一次，也可以自己按 /compact 压</li>
              <li>压过之后会话流里留一条记录，折了多少轮写在上面</li>
            </ul>
          </div>
          <div class="setting-row stack">
            <div class="setting-row-text">
              <span class="setting-row-label">版本控制</span>
            </div>
            <ul class="tool-uses">
              <li>工作区的改动实时统计在输入框上方，侧面板里可以逐份审阅</li>
              <li>提交、切分支这些由它自己跑 git 命令完成，不是单独的工具</li>
            </ul>
          </div>
        </div>
      </section>

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
