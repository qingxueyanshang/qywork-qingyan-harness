import { createResource, For, Show } from 'solid-js'
import { loaded } from '../../lib/resource.ts'
import { client, type SettingsPage, setSettingsPage, state } from '../../lib/store/index.ts'
import { IconChevron } from '../Icons.tsx'
import { LoadState } from './LoadState.tsx'

/**
 * 这个 agent 由什么组成。
 *
 * ## 只说明，不配置
 *
 * 这一页全是读数与边界，一个表单都没有。要改的东西在横线下面各自的操作台上，
 * 有操作台的组在组头给一个跳转。**没有操作台的组不给跳转按钮**——
 * 指向一个空页比不指更糟。
 *
 * ## 列底层名，不只列中文
 *
 * 上一版刻意只列中文用途、不列工具名，理由是「机制字段只在 CLI 里露面」。
 * 那条判据撑不住：同一个 `edit_file`，工具卡上写「修改文件」、参数表里写
 * `edit_file`、错误正文里又是别的说法，用户在三处见到三个名字，
 * 而能把它们对上的只有底层名。所以一行给全四样——**底层名 + 一句话 + 参数 + 权限**。
 *
 * 分组只有一层（`category`）。`facet` 那一层去掉了：它分的是「功能方向」，
 * 而这一页回答的是「能调什么」，一个工具名一行本来就看得完，再套一层是纯缩进。
 * 后端已按类目排好序，这里只分组不重排。
 *
 * ## 非工具的模块也占格子
 *
 * 上下文压缩、执行循环、版本控制、权限模式、沙箱——用户天天看得见，一个工具都不对应。
 * 不给它们格子，这一页读起来就像这些能力不存在。**每一条都指着界面上真实存在的
 * 东西**，没有「以后会有」的行。
 *
 * **加类目要同时改三处**：`registry.ts` 的联合类型、同处的 `TOOL_CATEGORIES` 数组、
 * 这里的 `MODULES`。漏了第三处不会报错——回落会拿类目 id 当标题显示，
 * 于是一整页中文里冒出一个英文 id。
 */

/** 一个模块。`id` 与 `ToolCategory` 同名的会收到工具行；`loop` / `vcs` 不是类目，永远只有说明。 */
interface Module {
  id: string
  label: string
  /** 这个模块的操作台。没有就不给按钮。 */
  consoles?: { page: SettingsPage; label: string }[]
  /** 不由工具承担的那部分。文案取实时读数，所以是函数。 */
  notes?: { label: string; text: () => string; warn?: () => boolean }[]
  /**
   * 一个工具都没有时整组不出现。
   *
   * 只有外部扩展是这样：执行循环、版本控制本来就没有工具，说明照样成立；
   * 而没装 MCP 也没装插件时，这一组能写的只剩一句「还没有装」——那是引导文案（B7）。
   */
  hideWhenEmpty?: boolean
}

const sandbox = () => state.capabilities?.sandbox ?? null

/** 命令方言由探测决定（bash → pwsh 7 → Windows PowerShell 5.1），握手只报 bash 那一格。 */
function shellNote(): string {
  const row = state.capabilities?.environment.find((d) => d.id === 'bash')
  if (!row) return '读取中…'
  if (row.path) return '这台机器有 bash，命令按 POSIX 方言写。'
  if (row.required) return '三种 shell 一个都没探到，run_command 没有注册。'
  return '这台机器没有 bash，命令落到 PowerShell 方言——`&&` 这类 POSIX 写法用不了。'
}

const MODULES: Module[] = [
  {
    id: 'files',
    label: '工作区文件',
    notes: [
      {
        label: '写前必读',
        text: () =>
          '改一个已存在的文件之前必须先读过它；读完之后文件又被动过，这次写入会被挡回去要求重读。',
      },
      {
        label: '路径边界',
        text: () =>
          '只能碰工作区，加上「命令与进程」里额外开的目录；软链接按真实路径判，.qy 与 .agents 一律不许写。',
      },
    ],
  },
  {
    id: 'code',
    label: '命令与进程',
    consoles: [{ page: 'access', label: '去配置' }],
    notes: [
      {
        label: '权限模式',
        text: () =>
          state.capabilities?.mode === 'full'
            ? '完全访问：命令不再逐条裁决。路径边界与沙箱照旧生效。'
            : '自动审批：逐条裁决 run_command，确定安全的才放行。MCP 与插件的工具是你自己装的，不过这道闸。',
      },
      {
        label: '沙箱',
        text: () => {
          const sb = sandbox()
          if (!sb) return '读取中…'
          return sb.active ? `已启用 · ${sb.backend}` : '无内核沙箱，命令直接跑在这台机器上'
        },
        warn: () => sandbox()?.active === false,
      },
      { label: '命令方言', text: shellNote },
    ],
  },
  {
    id: 'web',
    label: '网络',
    notes: [
      {
        label: 'SSRF 闸',
        text: () =>
          '私网与云元数据地址、非 http(s) 协议、非常规端口一律拒；重定向每跳重新判，最多 5 跳，并按解析出的 IP 直连以防 DNS 重绑定。',
      },
      { label: '出网策略', text: () => '只有默认这一档，没有可调的策略。' },
    ],
  },
  {
    id: 'knowledge',
    label: '记忆与技能',
    consoles: [
      { page: 'memory', label: '去记忆' },
      { page: 'skills', label: '去技能' },
    ],
    notes: [
      {
        label: '标题常驻，正文按需',
        text: () =>
          '每条记忆的 key 加首行、每个技能的名字加一句话，每一轮都在上下文里；正文由它自己去读。',
      },
      { label: '条数上限', text: () => '记忆最多 200 条，写满了写不进去。' },
    ],
  },
  {
    id: 'planning',
    label: '待办',
    notes: [
      { label: '整表替换', text: () => '每次提交的是整张清单，不是增删一条；最多 40 条。' },
      { label: '同时最多一条进行中', text: () => '多于一条当场判失败，不会替它纠正。' },
    ],
  },
  {
    id: 'goal',
    label: '目标',
    notes: [
      {
        label: '轮数上限',
        text: () => '默认 12 轮，最多 50 轮；撞上就停下来标记受阻，带一句理由。',
      },
      {
        label: '自动续起',
        text: () =>
          '挂在每一轮收尾：只有「正常收完」和「撞步数上限」才接着跑，报错、被中止、被权限拦下一律停。开关只在内存里，重启即失效——崩了不会自己复活。',
      },
    ],
  },
  {
    id: 'session',
    label: '上下文',
    notes: [
      {
        label: '压缩',
        text: () =>
          '触发点只有一个：发请求之前。阈值不是百分比——上下文窗口减掉最大输出，再留出四分之一给这一批工具结果。也可以自己按 /compact。',
      },
      {
        label: '占用分布',
        text: () => '哪一项占了多少、省略了什么，在输入框上方那条读数条上，这一页不列第二份。',
      },
    ],
  },
  {
    id: 'schedule',
    label: '调度',
    consoles: [{ page: 'schedules', label: '去配置' }],
    notes: [
      { label: '触发', text: () => '到点新开一条会话跑给定的提示词，最小粒度 1 分钟。' },
      { label: '边界', text: () => '应用关着就不跑，关闭期间错过的也不补。' },
    ],
  },
  {
    id: 'external',
    label: '外部扩展',
    hideWhenEmpty: true,
    consoles: [
      { page: 'mcp', label: '去 MCP' },
      { page: 'plugins', label: '去插件' },
    ],
    notes: [
      {
        label: '按需加载',
        text: () =>
          '外部工具多到一定量之后不再常驻工具表：模型先看到一行摘要，要用哪个自己装进来再调。量小的时候照旧全量常驻。',
      },
    ],
  },
  {
    id: 'loop',
    label: '执行循环',
    notes: [
      { label: '步数上限', text: () => '一轮最多 120 步；模型不再要工具就收工。' },
      {
        label: '并行波次',
        text: () =>
          '连着的调用里，工具自己声明可并行、且互相不碰同一份资源的，才会并成一波同时跑。',
      },
      {
        label: '停下来的时候',
        text: () =>
          '正常收完、撞步数上限、原地打转、你按了停、权限拒绝、输出被截断、模型报错、异常收尾——收尾那一行会写明是哪一种。',
      },
    ],
  },
  {
    id: 'vcs',
    label: '版本控制',
    notes: [
      { label: '改动统计', text: () => '工作区的改动实时统计在输入框上方，侧面板里可以逐份审阅。' },
      { label: '提交与分支', text: () => '由它自己跑 git 命令完成，不是单独的工具。' },
    ],
  },
]

/**
 * 权限副作用的中文名与轻重。
 *
 * 轻重不是装饰：`execute` 是唯一能绕开路径约束与 SSRF 闸的那条路，
 * 它和「写一个文件」不该在同一行里长得一样。
 *
 * `internal_control` 说「不走权限闸」而不是留空——留空看起来像漏填。
 */
const PERMS: Record<string, { label: string; warn?: number }> = {
  read: { label: '读取' },
  write: { label: '写入', warn: 1 },
  delete: { label: '删除', warn: 1 },
  network: { label: '出网', warn: 1 },
  execute: { label: '执行', warn: 2 },
  internal_control: { label: '不走权限闸' },
}

/** 后端遇到函数型字段会下发「不固定」，那时原样显示——编一个具体值才是撒谎。 */
function permText(effect: string): string {
  const p = PERMS[effect]
  if (!p) return effect
  return p.warn ? `${p.label} ${'⚠'.repeat(p.warn)}` : p.label
}

interface ToolRow {
  name: string
  category: string
  summary: string
  permissionEffect: string
  params: { name: string; required: boolean }[]
  source: string
}

export function ModulesSettings() {
  const [data, { refetch }] = createResource(() => client.api<{ tools: ToolRow[] }>('/api/tools'))

  /** 后端已按类目排好序，这里只分组不重排；只有说明没有工具的模块补在末尾。 */
  const groups = () => {
    const out: { mod: Module; rows: ToolRow[] }[] = []
    for (const row of loaded(data)?.tools ?? []) {
      let g = out[out.length - 1]
      if (!g || g.mod.id !== row.category) {
        g = {
          mod: MODULES.find((m) => m.id === row.category) ?? {
            id: row.category,
            label: row.category,
          },
          rows: [],
        }
        out.push(g)
      }
      g.rows.push(row)
    }
    for (const m of MODULES) {
      if (!m.notes || m.hideWhenEmpty) continue
      if (!out.some((g) => g.mod.id === m.id)) out.push({ mod: m, rows: [] })
    }
    return out
  }

  return (
    <Show
      when={loaded(data)}
      fallback={<LoadState error={data.error} onRetry={() => void refetch()} />}
    >
      <For each={groups()}>
        {(g) => (
          <section class="settings-block">
            <div class="settings-block-head">
              <h3>{g.mod.label}</h3>
              <Show when={g.mod.consoles}>
                {(cs) => (
                  <span class="module-consoles">
                    <For each={cs()}>
                      {(c) => (
                        <button
                          class="btn-ghost sm module-console"
                          type="button"
                          onClick={() => setSettingsPage(c.page)}
                        >
                          {c.label}
                          <IconChevron dir="right" size={12} />
                        </button>
                      )}
                    </For>
                  </span>
                )}
              </Show>
            </div>
            <div class="setting-rows">
              <For each={g.rows}>
                {(r) => (
                  <div class="setting-row stack">
                    <div class="module-tool">
                      <code class="module-name">{r.name}</code>
                      <Show when={r.source !== 'builtin'}>
                        <span class="module-src">{r.source}</span>
                      </Show>
                      <span class="module-summary">{r.summary}</span>
                      <span class="module-perm">{permText(r.permissionEffect)}</span>
                    </div>
                    <Show when={r.params.length > 0}>
                      <span class="module-params">
                        {r.params.map((p) => (p.required ? `${p.name}*` : p.name)).join(' · ')}
                      </span>
                    </Show>
                  </div>
                )}
              </For>
              <For each={g.mod.notes}>
                {(n) => (
                  <div class="setting-row stack" classList={{ warn: n.warn?.() === true }}>
                    <span class="setting-row-label">{n.label}</span>
                    <span class="setting-row-hint">{n.text()}</span>
                  </div>
                )}
              </For>
            </div>
          </section>
        )}
      </For>
    </Show>
  )
}
