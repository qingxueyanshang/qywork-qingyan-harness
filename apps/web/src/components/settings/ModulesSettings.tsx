import { createResource, For, Show } from 'solid-js'
import { loaded } from '../../lib/resource.ts'
import { client, type SettingsPage, setSettingsPage, state } from '../../lib/store/index.ts'
import { IconChevron } from '../Icons.tsx'
import { LoadState } from './LoadState.tsx'

/**
 * 这个 agent 由什么组成。
 *
 * **只说明，不配置。** 这一页全是读数与边界，一个表单都没有。要改的配置在横线下面各自的操作台上，
 * 有操作台的组在组头给一个跳转。**没有操作台的组不给跳转按钮**——
 * 指向一个空页比不指更糟。
 *
 * **列底层名，不只列中文用途。** 「机制字段只在 CLI 里露面」这条判据撑不住：
 * 同一个 `edit_file`，工具卡上写「修改文件」、参数表里写
 * `edit_file`、错误正文里又是别的说法，用户在三处见到三个名字，
 * 而能把它们对上的只有底层名。所以一行给全四样——**底层名 + 一句话 + 参数 + 权限**。
 *
 * 分组只有一层（`category`）。`facet` 那一层去掉了：它分的是「功能方向」，
 * 而这一页回答的是「能调什么」，一个工具名一行本来就看得完，再套一层是纯缩进。
 * 后端已按类目排好序，这里只分组不重排。
 *
 * **非工具的模块也占格子。** 上下文压缩、执行循环、版本控制、权限模式、沙箱——用户天天看得见，一个
 * 工具都不对应。不给它们格子，这一页读起来就像这些能力不存在。
 * **每一条都指着界面上真实存在的能力**，没有「以后会有」的行。
 *
 * **加类目要同时改三处**：`registry.ts` 的联合类型、同处的 `TOOL_CATEGORIES` 数组、
 * 这里的 `MODULES`。漏了第三处不会报错——回落会拿类目 id 当标题显示，
 * 因此一整页中文里冒出一个英文 id。
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

/** 命令语法由探测决定（bash → pwsh 7 → Windows PowerShell 5.1），握手只报 bash 那一格。 */
function shellNote(): string {
  const row = state.capabilities?.environment.find((d) => d.id === 'bash')
  if (!row) return '读取中…'
  if (row.path) return '有 bash，命令按 POSIX 语法写。'
  if (row.required) return '三种 shell 都未探测到，run_command 未注册。'
  return '无 bash，命令按 PowerShell 语法写。'
}

const MODULES: Module[] = [
  {
    id: 'files',
    label: '工作区文件',
    notes: [
      {
        label: 'read_before_write',
        text: () => '改已存在的文件前必须先读过；读完又被动过会挡回重读。',
      },
    ],
  },
  /*
   * 「命令怎么跑」与「准不准跑」是两件事，两个分类。
   *
   * 合在一个「命令与进程」里的时候，`run_command`、`sandbox`、`shell` 讲的是
   * 这条命令落到哪个 shell、跑在什么边界里，而 `mode` 讲的是它该不该被放行——
   * 用户要改审批模式时得在大量 shell 探测结果里找。
   */
  {
    id: 'code',
    label: '终端',
    // 终端这一组能配的只有 shell 本身（装 bash / 看探测到哪个），那在「通用 →
    // 运行环境」。指向「权限」是错的：那一页管的是能碰哪些路径，不管命令怎么跑。
    consoles: [{ page: 'general', label: '去配置' }],
    notes: [
      {
        label: 'sandbox',
        text: () => {
          const sb = sandbox()
          if (!sb) return '读取中…'
          return sb.active ? `已启用 · ${sb.backend}` : '无内核沙箱，命令直接在本机执行'
        },
        warn: () => sandbox()?.active === false,
      },
      { label: 'shell', text: shellNote },
    ],
  },
  {
    id: 'permission',
    label: '权限',
    consoles: [{ page: 'access', label: '去配置' }],
    notes: [
      {
        label: 'mode',
        text: () =>
          state.capabilities?.mode === 'full'
            ? '完全访问：不逐条裁决，路径边界一并放开。凭证剥离与沙箱不受影响。'
            : '自动审批：逐条裁决 run_command。MCP 与插件的工具不过这道闸。',
      },
      {
        label: 'additionalDirectories',
        text: () =>
          '工作区之外额外可读写的目录，软链接按真实路径判。.qy 与 .agents 由文件工具拦，shell 不拦；full 模式下这一层不设。',
      },
      {
        label: 'envAllowList',
        text: () => '显式放行的环境变量名。只豁免「名字像凭证」这一条，值命中已知 key 的仍然剥。',
      },
    ],
  },
  {
    id: 'web',
    label: '网络',
    notes: [
      {
        label: 'ssrf_guard',
        text: () => '私网与云元数据地址、非 http(s) 协议、非常规端口一律拒；重定向最多 5 跳。',
      },
      {
        label: 'sandboxNetwork',
        text: () => '配置文件里两档 allow / deny。deny 只在有内核沙箱的平台上生效，界面不给开关。',
      },
    ],
  },
  /*
   * 记忆和技能是两个类目，不是一个「记忆与技能」。
   *
   * 合着的时候这一组的说明行只能起中文名（「标题常驻，正文按需」「条数上限」）——
   * 因为它描述的是两个模块的共同点，代码里没有哪个标识对得上。拆开之后各自都有：
   * 上限是 `MAX_ENTRIES`（`tools/src/memory.ts`），进尾区的索引是
   * `buildTailNotes` 的 `memory` / `skills` 两个分组（`runtime/src/prompt.ts`）。
   */
  {
    id: 'memory',
    label: '记忆',
    consoles: [{ page: 'memory', label: '去配置' }],
    notes: [
      { label: 'memory', text: () => '记忆的 key 与首行常驻上下文尾区，正文按需读。' },
      { label: 'MAX_ENTRIES', text: () => '最多 200 条，满了之后写入失败。' },
    ],
  },
  {
    id: 'skills',
    label: '技能',
    consoles: [{ page: 'skills', label: '去配置' }],
    notes: [{ label: 'skills', text: () => '技能名与一句话描述常驻上下文尾区，正文按需读。' }],
  },
  {
    id: 'planning',
    label: '待办',
    notes: [
      { label: 'MAX_ITEMS', text: () => '每次提交的是整张清单，不是增删一条；最多 40 条。' },
      { label: 'in_progress', text: () => '同时最多一条；多于一条当场判失败，不会替它纠正。' },
    ],
  },
  {
    id: 'goal',
    label: '目标',
    notes: [
      /*
       * **没有轮数上限。** 不要在这里写「默认 12 轮，最多 50 轮」之类的数字：
       * 代码里不存在这样的配额（`core/domain/model.ts` 的 `Goal` 注释写明了），
       * 写了就是一条用户会照着算的假数据。
       */
      {
        label: 'CONTINUABLE',
        text: () =>
          '只有正常收尾或撞上步数上限才续起下一轮，其余一律停。没有轮数上限：出口是模型宣布做完、做不下去，或用户停止。',
      },
    ],
  },
  {
    id: 'session',
    label: '上下文',
    notes: [
      {
        label: 'TRIGGER_RATIO',
        text: () => '每次发请求前判定；上下文占用超过窗口的 80% 时先压缩再发出。',
      },
    ],
  },
  {
    id: 'schedule',
    label: '调度',
    consoles: [{ page: 'schedules', label: '去配置' }],
    notes: [
      {
        label: 'isDue',
        text: () =>
          '触发时新开一条会话执行给定的提示词，最小粒度 1 分钟。应用未运行时不触发，错过的不补跑。',
      },
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
        label: 'PendingToolPool',
        text: () => '外部工具超过一定数量后不再常驻：模型只看到一行摘要，需要时用 load_tool 加载。',
      },
    ],
  },
  {
    id: 'loop',
    label: '执行循环',
    notes: [
      { label: 'DEFAULT_MAX_STEPS', text: () => '一轮最多 120 步；模型不再请求工具即结束本轮。' },
      {
        label: 'isParallelSafe',
        text: () => '声明了可并行、且不涉及同一份资源的连续调用才并成一波。',
      },
      { label: 'StopReason', text: () => '收尾那一行标明本轮的停止原因。' },
    ],
  },
  {
    id: 'vcs',
    label: '版本控制',
    notes: [
      { label: 'FileChange', text: () => '改动实时统计在输入框上方，侧面板里逐份审阅。' },
      { label: 'git', text: () => '提交与分支由模型执行 git 命令完成，没有单独的工具。' },
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

/** 后端遇到函数型字段会下发「不固定」，那时原样显示——填一个具体值就是编数据。 */
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
    /*
     * 顺序按 `MODULES` 写的来。
     *
     * 不要按「先排带工具的、纯说明的放最后」来排：那样「权限」这种没有工具的模块
     * 会掉到页尾，离它对应的「终端」隔着半屏。
     * 后端认得的类目在 `MODULES` 里都有一条，所以这一次排序对它们是恒等；
     * 真排不到的（后端加了类目而这里漏登记）留在末尾，那正好是需要被看见的位置。
     */
    const rank = (id: string) => {
      const i = MODULES.findIndex((m) => m.id === id)
      return i === -1 ? MODULES.length : i
    }
    return out.sort((a, b) => rank(a.mod.id) - rank(b.mod.id))
  }

  return (
    <>
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
                {/* 说明行的名字取的是代码里那个标识（`mode`、`sandbox`…），
                  所以和工具名同一种写法——一个用等宽一个用正文，那本身就是中英混排。 */}
                <For each={g.mod.notes}>
                  {(n) => (
                    <div class="setting-row stack" classList={{ warn: n.warn?.() === true }}>
                      <code class="module-name">{n.label}</code>
                      <span class="setting-row-hint">{n.text()}</span>
                    </div>
                  )}
                </For>
              </div>
            </section>
          )}
        </For>
      </Show>
    </>
  )
}
