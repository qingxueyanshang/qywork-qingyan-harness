import { createResource, For, Show } from 'solid-js'
import { loaded } from '../../lib/resource.ts'
import { client, type SettingsPage, setSettingsPage, state } from '../../lib/store/index.ts'
import { IconChevron } from '../Icons.tsx'
import { config, ensureConfig, patchConfig } from './configStore.ts'
import { LoadState } from './LoadState.tsx'
import { OnOff } from './OnOff.tsx'

/**
 * 设置页「模块」：列出 agent 的组成部分，即各类工具与不由工具承担的机制。
 *
 * - 有设置页的分组在分组标题右侧提供跳转按钮；没有设置页的分组不提供按钮，指向空页面没有意义。
 *   例外是分组本身的启用状态：它没有其他设置位置，在分组标题右侧提供开关（`Module.toggle`）。
 * - 每行列出底层名称、用途、参数与权限。同一工具在工具卡、参数表与错误信息中的中文说法可能不同，
 *   只有底层名称（如 `edit_file`）能把三处对应起来。
 * - 分组只有一层（`category`），不再按 `facet` 细分：本页说明可调用哪些工具，每个工具一行即可浏览。
 *   后端已按类目排序，此处只分组，不重新排序。
 * - 不对应工具的模块（上下文压缩、执行循环、版本控制、权限模式、沙箱）同样列出，否则本页会显得这些能力不存在。
 *   每一条都对应界面上已有的能力，不列尚未实现的条目。
 * - 新增类目须同时修改三处：`registry.ts` 的联合类型、同文件的 `TOOL_CATEGORIES` 数组与本文件的 `MODULES`。
 *   遗漏本文件不会报错，分组标题会回退为英文类目 id。
 */

/** 一个模块。`id` 与 `ToolCategory` 同名时接收该类目的工具行；`loop` / `vcs` 不是类目，只显示说明行。 */
interface Module {
  id: string
  label: string
  /** 该模块的设置页。没有设置页时不显示按钮。 */
  consoles?: { page: SettingsPage; label: string }[]
  /**
   * 分组标题右侧的开关，读写配置中的一个字段。
   *
   * 提供开关时不再提供 `consoles`：两者占用同一位置，且「本组是否启用」与「前往设置页」
   * 回答的是同一个问题，并列显示时用户无法判断应点击哪一个。
   */
  toggle?: { on: () => boolean; onPick: (on: boolean) => void }
  /** 分组标题旁的运行环境状态，与模块启用开关独立。 */
  environment?: () => { text: string; missing: boolean }
  /** 不由工具承担的部分。文案取自实时状态，因此是函数。 */
  notes?: { label: string; text: () => string; warn?: () => boolean }[]
}

const sandbox = () => state.capabilities?.sandbox ?? null

/**
 * 电脑控制开关的读数：字段缺失视为开启，只有显式 `false` 才视为关闭。
 *
 * 与服务端装配桌面端口的判据（`server.ts` 的 `desktopEnabled !== false`）一致；
 * 两处不一致时，界面显示已启用，而模型没有这组工具。
 */
export function desktopSwitchOn(cfg: { desktopEnabled?: boolean } | null): boolean {
  return cfg?.desktopEnabled !== false
}

/** 浏览器控制开关的读数：字段缺失视为开启，与服务端装配浏览器端口的判据（`browserEnabled !== false`）一致。 */
export function browserSwitchOn(cfg: { browserEnabled?: boolean } | null): boolean {
  return cfg?.browserEnabled !== false
}

/** Office 开关的读数：字段缺失视为开启，与服务端获取端口的判据（`officeEnabled !== false`）一致。 */
export function officeSwitchOn(cfg: { officeEnabled?: boolean } | null): boolean {
  return cfg?.officeEnabled !== false
}

/** 「画布与生成」开关的读数：字段缺失视为开启，与会话注册这组工具的判据（`mediaEnabled !== false`）一致。 */
export function mediaSwitchOn(cfg: { mediaEnabled?: boolean } | null): boolean {
  return cfg?.mediaEnabled !== false
}

/**
 * Office 分组的可用状态：Python 与文档库均已安装才可用，缺失项在「通用 → 运行环境」中安装。
 * 读取握手中的运行环境表，与该页的两行使用同一次检测结果。
 */
function officeState(): { text: string; missing: boolean } {
  const rows = state.capabilities?.environment
  const python = rows?.find((d) => d.id === 'python')
  const libs = rows?.find((d) => d.id === 'office-libs')
  if (!python || !libs) return { text: '读取中…', missing: false }
  if (!python.path) return { text: '需要安装 Python', missing: true }
  if (!libs.path) return { text: '需要安装 Office 文档库', missing: true }
  return { text: '可用', missing: false }
}

/** 命令语法由检测结果决定（bash → pwsh 7 → Windows PowerShell 5.1）；握手只报告 bash 一项。 */
function shellNote(): string {
  const row = state.capabilities?.environment.find((d) => d.id === 'bash')
  if (!row) return '读取中…'
  if (row.path) return '已检测到 bash，命令使用 POSIX 语法。'
  if (row.required) return '未检测到可用的 shell，run_command 未注册。'
  return '未检测到 bash，命令使用 PowerShell 语法。'
}

const MODULES: Module[] = [
  {
    id: 'files',
    label: '工作区文件',
    notes: [
      {
        label: 'read_before_write',
        text: () => '修改已有文件前必须先读取；读取后文件再被修改时，写入被拒绝并要求重新读取。',
      },
    ],
  },
  /*
   * 「命令如何运行」与「是否准许运行」分为两个分类。
   *
   * 合为一个分类时，`run_command`、`sandbox`、`shell` 说明命令由哪个 shell 执行、在什么边界内执行，
   * 而 `mode` 说明命令是否放行；用户修改审批模式时需要在 shell 检测结果中查找。
   */
  {
    id: 'code',
    label: '终端',
    // 终端分组可配置的只有 shell（安装 bash、查看检测结果），位于「通用 → 运行环境」。
    // 不要指向「权限」：该页管理可访问的路径，不管理命令的执行方式。
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
            ? '完全访问 · 沙箱与凭证剥离不受影响'
            : '自动审批 · MCP 与插件工具不经权限检查',
      },
      {
        label: 'additionalDirectories',
        text: () =>
          '工作区之外额外允许读写的目录；符号链接按实际路径判定。.qy 与 .agents 目录由文件工具拦截，shell 不拦截；完全访问模式下不设此限制。',
      },
      {
        label: 'envAllowList',
        text: () =>
          '明确放行的环境变量名。仅豁免按名称识别凭证的规则；值与已知 API key 相同的变量仍会被剥离。',
      },
    ],
  },
  {
    id: 'web',
    label: '网络',
    notes: [
      {
        label: 'ssrf_guard',
        text: () => '拒绝访问内网与云元数据地址、非 http(s) 协议及非常用端口；重定向最多 5 次。',
      },
      {
        label: 'sandboxNetwork',
        text: () => '在配置文件中设置为 allow 或 deny；deny 仅在具备内核沙箱的平台上生效。',
      },
    ],
  },
  // 分组标题为开关，理由同电脑控制。
  {
    id: 'browser',
    label: '浏览器控制',
    toggle: {
      on: () => browserSwitchOn(config()),
      onPick: (on) => void patchConfig({ browserEnabled: on }),
    },
  },
  /*
   * 分组标题为开关而不是「去配置」：本组是否启用只由这一项决定，没有其他设置位置。
   * 占用真实鼠标与键盘的前台操作在「权限」页设置，属于另一个问题。
   *
   * 不添加以内部键名为标签的说明行：`desktopEnabled` 的含义已由开关表达，
   * `dispatch` 是宿主回执的协议字段，用户无法据此作出判断（B7）。
   */
  {
    id: 'desktop',
    label: '电脑控制',
    toggle: {
      on: () => desktopSwitchOn(config()),
      onPick: (on) => void patchConfig({ desktopEnabled: on }),
    },
  },
  /*
   * 分组标题为开关，理由同电脑控制。缺少 Python 或文档库时，开关开启也无法使用：
   * 标题旁显示环境状态，安装入口在「通用 → 运行环境」；render 行说明能力边界。
   */
  {
    id: 'office',
    label: 'Office 文档',
    environment: officeState,
    toggle: {
      on: () => officeSwitchOn(config()),
      onPick: (on) => void patchConfig({ officeEnabled: on }),
    },
    notes: [
      {
        label: 'render',
        text: () => '渲染、公式重算与目录页码更新依赖本机的 Word 或 WPS，仅支持 Windows。',
      },
    ],
  },
  // 分组标题为开关，理由同电脑控制。
  {
    id: 'media',
    label: '画布与生成',
    toggle: {
      on: () => mediaSwitchOn(config()),
      onPick: (on) => void patchConfig({ mediaEnabled: on }),
    },
  },
  /*
   * 记忆与技能是两个类目，不合并为「记忆与技能」。
   *
   * 合并时说明行描述的是两个模块的共同点，代码中没有对应的标识符，只能另起中文名称。
   * 分开后各自有对应的标识符：上限为 `MAX_ENTRIES`（`tools/src/memory.ts`），上下文末尾的索引为
   * `buildTailNotes` 的 `memory` / `skills` 两个分组（`runtime/src/prompt.ts`）。
   */
  {
    id: 'memory',
    label: '记忆',
    consoles: [{ page: 'memory', label: '去配置' }],
    notes: [
      { label: 'memory', text: () => '记忆的名称与首行始终附在上下文末尾，正文按需读取。' },
      { label: 'MAX_ENTRIES', text: () => '最多 200 条，达到上限后无法写入。' },
    ],
  },
  {
    id: 'skills',
    label: '技能',
    consoles: [{ page: 'skills', label: '去配置' }],
    notes: [
      { label: 'skills', text: () => '技能名称与简短描述始终附在上下文末尾，正文按需读取。' },
    ],
  },
  {
    id: 'planning',
    label: '待办',
    notes: [
      { label: 'MAX_ITEMS', text: () => '每次提交完整清单，而非单条增删；最多 40 条。' },
      { label: 'in_progress', text: () => '同一时间最多一条；超过一条时提交失败，不会自动修正。' },
    ],
  },
  {
    id: 'goal',
    label: '目标',
    notes: [
      /*
       * 不设轮数上限。不要在此写「默认 12 轮，最多 50 轮」之类的数字：代码中没有这样的配额
       * （见 `core/domain/model.ts` 中 `Goal` 的注释），写入即构成用户会据以计算的错误数据。
       */
      {
        label: 'CONTINUABLE',
        text: () =>
          '仅在本轮正常结束后自动开始下一轮。轮数不设上限；模型声明目标完成、连续无进展、发生不可恢复的错误或用户停止时终止。',
      },
    ],
  },
  {
    id: 'session',
    label: '上下文',
    notes: [
      {
        label: 'TRIGGER_RATIO',
        text: () => '每次请求前检查；上下文用量超过窗口的 80% 时先压缩再发送。',
      },
    ],
  },
  {
    id: 'schedule',
    label: '定时任务',
    consoles: [{ page: 'schedules', label: '去配置' }],
    notes: [
      {
        label: 'isDue',
        text: () =>
          '触发时新建会话执行指定的提示词，最小间隔 1 分钟。仅在应用运行时触发；关闭期间错过的执行不逐次补齐，重新打开后每条任务最多补执行一次。',
      },
    ],
  },
  // 按需加载的边界已在「上下文」分组 load_tool 一行的用途中写明，此处不重复。
  { id: 'mcp', label: 'MCP', consoles: [{ page: 'mcp', label: '去配置' }] },
  { id: 'plugins', label: '插件', consoles: [{ page: 'plugins', label: '去配置' }] },
  {
    id: 'loop',
    label: '执行循环',
    notes: [
      {
        label: 'run',
        text: () => '不设固定轮数上限；模型完成任务、连续无进展、出错或用户停止时结束。',
      },
      {
        label: 'isParallelSafe',
        text: () => '声明可并行且不涉及同一资源的连续调用合并为一批并行执行。',
      },
      { label: 'StopReason', text: () => '每轮末尾的摘要行显示本轮的停止原因。' },
    ],
  },
  {
    id: 'vcs',
    label: '版本控制',
    notes: [
      {
        label: 'FileChange',
        text: () => '改动统计实时显示在输入框上方，可在侧面板中逐个文件审阅。',
      },
      { label: 'git', text: () => '提交与分支操作由模型执行 git 命令完成，不提供单独的工具。' },
    ],
  },
]

/**
 * 权限副作用的中文名称与警示级别。
 *
 * 警示级别用于区分风险：`execute` 是唯一能绕过路径约束与 SSRF 防护的方式，不应与写入文件显示为同一级别。
 *
 * `internal_control` 显示「不经权限检查」而不是留空，留空会被看作漏填。
 */
const PERMS: Record<string, { label: string; warn?: number }> = {
  read: { label: '读取' },
  write: { label: '写入', warn: 1 },
  delete: { label: '删除', warn: 1 },
  network: { label: '网络访问', warn: 1 },
  browser: { label: '浏览器控制', warn: 1 },
  desktop: { label: '电脑控制', warn: 2 },
  execute: { label: '执行', warn: 2 },
  internal_control: { label: '不经权限检查' },
}

/** 后端遇到函数型字段时下发「不固定」，此时原样显示；填入具体值即构成虚构数据。 */
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
}

export function ModulesSettings() {
  // 分组标题的开关读写同一份服务端配置，与各设置页共用（见 `configStore.ts`）。
  ensureConfig()
  const [data, { refetch }] = createResource(() => client.api<{ tools: ToolRow[] }>('/api/tools'))

  /** 后端已按类目排序，此处只分组，不重新排序；只有说明行、没有工具的模块追加在末尾。 */
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
      if (!m.notes) continue
      if (!out.some((g) => g.mod.id === m.id)) out.push({ mod: m, rows: [] })
    }
    /*
     * 按 `MODULES` 中的顺序排列。
     *
     * 不要改为「有工具的在前、只有说明行的在后」：那样「权限」这类没有工具的模块会移到页面末尾，
     * 与对应的「终端」相隔半屏。
     * 后端已知的类目在 `MODULES` 中都有一条，因此这次排序不改变它们的相对顺序；
     * 未登记的类目（后端新增而此处遗漏）排在末尾，便于发现。
     */
    const rank = (id: string) => {
      const i = MODULES.findIndex((m) => m.id === id)
      return i === -1 ? MODULES.length : i
    }
    return out.sort((a, b) => rank(a.mod.id) - rank(b.mod.id))
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
              <Show when={g.mod.environment?.()}>
                {(environment) => (
                  <span class="module-environment" classList={{ warn: environment().missing }}>
                    运行环境：{environment().text}
                  </span>
                )}
              </Show>
              {/* 配置加载完成后才渲染开关：加载前点击无法写入，且界面上不显示失败。 */}
              <Show when={g.mod.toggle}>
                {(t) => (
                  <Show when={config()}>
                    <OnOff on={t().on()} onPick={t().onPick} />
                  </Show>
                )}
              </Show>
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
              {/* 说明行的名称取自代码中的标识符（`mode`、`sandbox` 等），因此与工具名同样使用等宽字体。 */}
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
  )
}
