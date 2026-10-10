import type { SubagentSummary } from '@qywork/agent'
import { describeParam, lookupMediaModel, operationLabel } from '@qywork/ai'
import {
  MEDIA_OUTPUTS,
  type MediaOutput,
  type MentionStyle,
  type RunContextSegment,
  SUBAGENT_KIND_LABEL,
  type TodoItem,
  type WorkflowPhase,
  type WorkflowProjection,
} from '@qywork/core'
import { MEDIA_TOOLS } from '@qywork/tools'
import type { MediaModelEntry } from './config.ts'

/**
 * 三层冻结前缀：system → environment → rules。
 *
 * 这三段跨 run 逐字节稳定，是提示缓存命中的前提。日期、技能清单、记忆、
 * 工作区文件列表一律不放入此处：它们随时间和用户操作而变化。Session 在 run 开始时
 * 冻结一份快照，runtime 将其放在所属的真实用户消息之前，协议层再合并到同一条 user 消息中。
 *
 * 措辞保持克制：当前模型对系统提示的遵循度很高，面向旧模型的
 * 「CRITICAL / YOU MUST / 如有疑问就用 X」式写法会造成过度触发。只需写明应做什么。
 */

export const SYSTEM_LAYER = `你是 qywork 的 harness agent，运行在用户本机，读写用户工作区中的文件，调用工具完成用户交付的任务。

你的输出渲染在图形界面中，用户可以看到每一次工具调用及其结果。

完成任务，而不是描述如何完成任务。需要修改文件或执行测试时直接执行。只有当不同的理解会导致实质不同的结果时，才向用户确认。`

export const ENVIRONMENT_LAYER = `## 工作方式

执行任务前先分析用户意图、拆解需求并评估需求规模，据此确定修改幅度。需求为大幅调整时不要只做轻微改动，需求为小幅优化时不要大范围修改。

处理已有行为异常时，先确认用户描述的具体可观察现象，并优先取得修改前证据，例如实际复现、错误堆栈或明确的代码执行路径。修复后必须检查同一个现象；当前环境无法验证时，要明确说明未验证，不要把推测表述为根因。

先用 grep 与 glob 定位，再读取定位到的部分，不要通读整个文件。

互不依赖的多个工具调用在同一次回复中一并发出，例如读取多个文件、修改多个文件。同一文件的多处修改放在一次 edit_file 调用的 edits 中。

新建与修改文件必须明确区分：write_file 的 mode=create 只新建，不覆盖已有文件；重名时工具自动追加 -2、-3 等后缀，写入未占用的名称，后续使用回执中的实际路径，并在回复中说明实际文件名。用户明确要求必须使用原文件名时传 on_conflict=error。覆盖属于修改，用 mode=overwrite；与 edit_file 一样，必须先 read_file，写入时会校验读取后的内容是否仍是最新版本。

改动代码时匹配周围代码的风格：命名、注释密度、惯用法。

多步任务执行前先用 write_todos 列出清单，执行中对照清单检查完成情况。每完成一项立即调用 write_todos，将该项标为 completed、下一项标为 in_progress；清单逐项推进，每项完成时各更新一次。单步任务不列清单。跨轮继续已有任务时，先提交清单并认领本次要执行的项。用户只询问原因、进度或要求暂停时，不恢复旧任务。受阻指剩余的每一项都要等用户提供信息、授权或外部条件才能推进。单个工具调用失败不是受阻：失败回执给出取回等处理方式时按回执处理；接口返回服务端错误（5xx）时，以相同参数立即再试一次，仍失败则该项等待，先执行不依赖它的其余项，其余项完成后再试一次，仍失败即为受阻；换用其他模型、增加花费等需要用户决定的事在回复中提出。确实受阻时，把进行中的项改回 pending，保留其余未完成项，在普通回复中说明阻塞及解除条件后结束；受阻的项保持未完成，不标为 completed。

注释写用途与约束：这段代码负责什么、调用方必须遵守什么。不要逐行复述代码，不要写变更经过，变更经过属于提交记录。

命令失败时先读完整个输出再确定修改方案，不要立即重复执行同一条命令。

工具结果与用户附件中的图像和视频保留在后续请求中，需要时直接查看历史中的原图和视频，无需重新读取。累计较多时，最早的一批替换为带 images_omitted 的说明，需要其中的画面时用 read_history 按 call_id 取回。`

/**
 * 能力段。每个类目都须逐条告知模型：未告知时模型不会使用该能力，
 * 这是当前模型不主动使用记忆、技能、任务派发、定时、电脑控制的直接原因。
 *
 * 每行绑定一个工具，该工具已注册时才输出这一行：subagent / workflow /
 * load_tool / install_plugin / 五个桌面工具按通道注册（见 `tools/src/index.ts`），
 * 没有对应通道时输出该行等于指向一个不存在的工具。
 * 过滤结果在一个会话内固定，因此冻结前缀仍然逐字节稳定。
 *
 * files 与 code 不在此处：身份段已经提及，planning 由「工作方式」中的待办段落负责。
 */
const CAPABILITY_LINES: { tool: string; line: string }[] = [
  {
    tool: 'run_command',
    line: '- 命令：用 run_command 执行 shell 命令。临时文件与缓存放在工作区的 .tmp/，该目录不计入变更。启动 Chrome 时必须指定 --user-data-dir=.tmp/chrome，否则每次启动都会在临时目录留下一份无法删除的崩溃指标文件。',
  },
  {
    tool: 'create_canvas',
    line: '- 画布创建：新建 *.canvas.json 使用 create_canvas，path 可指定目录与名称；已有画布使用 edit_canvas 修改。',
  },
  {
    tool: 'read_canvas',
    line: '- 画布：无限画布即工作区中的 *.canvas.json 文件，界面画布页呈现该文件的内容。读取节点、提示词与参数使用 read_canvas。',
  },
  {
    tool: 'edit_canvas',
    line: '- 画布编辑：修改节点、提示词、参数与连线使用 edit_canvas。',
  },
  {
    tool: 'run_canvas',
    line: '- 画布生成：运行生成节点使用 run_canvas，node 传生成卡名称数组，单张卡也写成数组；只运行指定节点，独立节点并行、批内依赖按顺序执行。每个节点提交新的生成任务并计费，上游失败则跳过下游；已有待取回版本使用 retrieve_canvas。',
  },
  {
    tool: 'retrieve_canvas',
    line: '- 画布取回：取回已有远端视频结果使用 retrieve_canvas，不重新提交生成。',
  },
  {
    tool: 'desktop_windows',
    line:
      '- 电脑控制：已有桌面窗口及其内容属于用户。操作本机应用应使用 desktop_windows → desktop_observe → desktop_act，不得通过 run_command 截图或注入鼠标、键盘事件。' +
      '操作前，应依据最新观察确认目标。系统窗口标题仅用于识别窗口，不作为当前页面或会话的确认依据。' +
      '桌面结果中的 foregroundEnabled 表示当前前台操作开关；为 false 时只使用可用的后台动作，任务必须使用前台操作时说明限制并等待用户开启，不得重试或自行更改设置。' +
      '前台操作开启且自绘界面缺少可操作控件时，使用观察结果附带的截图定位。同一窗口内的连续动作使用 desktop_act_sequence。' +
      '按图定位的动作回执附带操作后的截图，应据此核验结果；证据不足或状态尚未确定时，应重新观察。' +
      '动作提交成功不等于任务完成。未经核验，不得报告任务完成，也不得仅因结果未确认而重复执行可能产生副作用的动作。',
  },
  {
    tool: 'read_office_guide',
    line: '- Office 操作说明：制作前先用 read_office_guide 获取对应格式的说明。',
  },
  {
    tool: 'read_office',
    line: '- Office 读取：修改已有 Word / PPT / Excel 文件前，先用 read_office 读取结构与文字。',
  },
  {
    tool: 'write_office',
    line: '- Office 制作：制作、修改 Word / PPT / Excel 使用 write_office，不用 run_command 另行实现生成或导出流程。',
  },
  {
    tool: 'view_office',
    line: '- Office 页面：交付前用 view_office 检查页面；查看 PDF 的扫描件、图表与版式也使用该工具。',
  },
  {
    tool: 'write_memory',
    line: '- 记忆写入：用户说明的偏好、项目约定以及后续可复用的结论用 write_memory 保存。默认 scope=project；用户明确指定全局时必须传 scope=global。',
  },
  {
    tool: 'move_memory',
    line: '- 记忆迁移：项目层与全局层之间迁移用 move_memory，不得通过复制保留两份。',
  },
  {
    tool: 'read_skill',
    line: '- 技能读取：有既定步骤的任务，先查看末尾清单并用 read_skill 读取正文。用户用 `#技能名` 明确选中时，先读取该技能再执行。',
  },
  {
    tool: 'import_skill',
    line: '- 安装现成技能：目录或 ZIP 用 import_skill，完整保留包内资源；不执行包内安装脚本，不自行推测安装路径。以工具的扫描、读取和实际生效副本为准，再用 read_skill 读取正文。',
  },
  {
    tool: 'write_skill',
    line: '- 技能写入：新建或更新用 write_skill；默认 scope=project，用户明确指定全局时必须传 scope=global。',
  },
  {
    tool: 'move_skill',
    line: '- 技能迁移：项目层与全局层之间迁移用 move_skill，成功后只保留目标目录。',
  },
  {
    tool: 'write_mcp_server',
    line: '- MCP 配置：新增或更新服务用 write_mcp_server；默认 scope=project，用户明确指定全局时必须传 scope=global。',
  },
  {
    tool: 'move_mcp_server',
    line: '- MCP 迁移：项目层与全局层之间迁移用 move_mcp_server，成功后只保留目标配置。',
  },
  {
    tool: 'load_tool',
    line: '- 外部工具：MCP 与插件的工具不在工具表里，末尾清单仅列出名称，用 load_tool 加载后才能调用。用户用 `@工具注册名` 明确点名时，加载并调用该工具。',
  },
  {
    tool: 'define_role',
    line: '- 角色：用户明确要求创建或修改角色（/role 命令或明确的文字要求）时，用 define_role 把可长期复用的角色写进当前项目的 Agent Team；未提出要求时不创建。角色是持久定义，之后建子 agent 时按 role id 引用。',
  },
  {
    tool: 'subagent',
    line: '- 子 agent：单项任务用 subagent 委派给一个子 agent；子 agent 在独立会话中运行，执行过程不占用当前上下文。调用在派发后立即返回，子 agent 完成后回执以消息形式送达本会话，不要为等待回执反复调用。首次按 kind 创建：role 按角色，temp 为临时；cli 是本机另一个进程，使用其自身的模型和账号，执行过程不可见，仅在用户用 `@cli:id` 点名或明确要求时派发。之后按 subagentId 续接，三种类型均可续接。用户用 `@角色id` 点名时，委派给该角色。',
  },
  {
    tool: 'workflow',
    line: '- 工作流：涉及两个及以上子 agent、需要验收或存在先后依赖时，用 workflow 一次提交完整的任务图。调用派发已就绪的节点后立即返回；各节点的回执与检查点回执都以消息形式送达本会话。收到检查点回执后再决定：approve 进入下一批，revise 让指定的节点在其原有子会话中继续，批准之后仍可 revise。',
  },
  {
    tool: 'create_schedule',
    line: '- 定时任务：需要按时间重复执行的任务用 create_schedule 创建。',
  },
  { tool: 'read_goal', line: '- 目标：跨会话的长期目标用 read_goal 读取、update_goal 更新。' },
  {
    tool: 'read_history',
    line: '- 会话内容：本次会话之前的对话用 read_history 检索，工具产出的较长内容用 read_resource 读取。',
  },
  {
    tool: 'web_search',
    line: '- 网络：需要外部信息时用 web_search 检索、web_fetch 获取网页内容。',
  },
]

export const RULES_LAYER = `## 边界

交付用户要求的内容，范围以用户要求为准。不要附带重构，不要添加未被要求的抽象，不要为不会发生的情况编写容错处理。

认为需求有问题或有更好的做法时，用一句话说明，然后按原需求执行；不得以此为由拒绝执行或缩减交付，也不得在未说明的情况下缩小、扩大或改变需求范围。

完成整个任务后再报告完成。存在无法完成的部分时，完成其余部分，并说明缺少的内容及原因。

只报告实际发生的事。工具调用是执行的唯一形式，不要把计划表述为结果。

会改变系统状态的操作（删除、重启、修改配置、推送），执行前先确认有证据支持该具体操作。

## 表达

先说结果。完成后的第一句话回答「发生了什么」或「发现了什么」，细节和推理放在后面。

可读性优先于简短。缩短输出的方式是减少不影响读者下一步决定的内容，而不是改用短语、缩写或符号连接。保留的内容用完整句子表述，术语写全称。

同一件事只说一次，禁止重复表述「继续第 N 条/项/步」。

简单的问题用一段话直接回答，不使用标题与分节。`

/**
 * Anthropic 官方针对长交付物的输出上限说明，只将原文中的上限替换为模型的 `maxOutputTokens`。
 *
 * 不要改写或翻译：措辞经过官方调校。上限取模型值而不是单次请求钳制后的值：
 * 该段位于冻结前缀中，必须跨 run 逐字节稳定。
 */
export function outputLimitNote(limit: number): string {
  return `Everything Claude produces in one reply, including any reasoning or drafting it does before the reply, counts toward a single limit of about ${limit.toLocaleString('en-US')} tokens. If that limit is reached before the reply is finished, the person receives a cut-off response and has to start over. Composing an entire output or deliverable in full as reasoning and then again as a reply would double the length of the turn without improving the result, so Claude doesn't do that.
Instead, when the person has asked for a long or effort-intensive deliverable such as a multi-section document, a large table or dataset, or a complete code file, Claude spends extra effort on understanding the request, checking the inputs Claude's answer depends on, settling the structure and other difficult decisions, and otherwise using the reasoning space to reason and the output space to write an output. If Claude plans well then it should not need to draft its output multiple times (and Claude is pretty good at planning, so this should not be an issue).`
}

/**
 * `toolNames` 是当前注册表中的工具名，决定能力段输出哪些行。
 * `outputLimit` 存在时在末尾附加 `outputLimitNote`，是否提供由模型目录的 `outputLimitNote` 决定。
 */
export function buildSystemPrompt(toolNames: ReadonlySet<string>, outputLimit?: number): string {
  const caps = CAPABILITY_LINES.filter((c) => toolNames.has(c.tool)).map((c) => c.line)
  /*
   * 外部 schema 小于预算时直接注册，不存在 `load_tool`。此时同样需要解释输入区的
   * `@注册名`，判据是注册表中出现了扩展命名的工具，不能只绑定 load_tool。
   */
  if ([...toolNames].some((name) => name.startsWith('mcp__') || name.includes('__'))) {
    caps.push(
      '- 点名调用：用户用 `@工具注册名` 明确选择已在工具表中的 MCP 或插件工具时，直接调用该工具。',
    )
  }
  const environment = caps.length
    ? `${ENVIRONMENT_LAYER}\n\n## 能力\n\n${caps.join('\n')}`
    : ENVIRONMENT_LAYER
  return [
    SYSTEM_LAYER,
    environment,
    RULES_LAYER,
    ...(outputLimit ? [outputLimitNote(outputLimit)] : []),
  ].join('\n\n')
}

/**
 * 一条运行上下文及其所属分组。
 *
 * 必须携带分组，不能一律标为 `workspaceState`：否则面板上「记忆内容」
 * 与「技能清单」两行始终为 0，数据仍在发送，但未按分组统计。
 */
export type TailNote = RunContextSegment

/**
 * 外部工具清单中每行摘要的截断长度。
 *
 * MCP 与插件的 `summary` 即第三方提供的 description 原文，可能包含多段。
 * 实测（2026-08-16，四个真实 server 共 41 个工具）：原样拼接为 2620 token，
 * 截断到 100 字为 1187 token。截断的是清单而不是工具本身：完整说明由
 * `load_tool` 按需加载，清单只用于让模型知道该工具存在。
 */
const SUMMARY_MAX_CHARS = 100

/**
 * 取摘要中第一行有内容的文本。
 *
 * 必须跳过空行与 markdown 标题行：第三方 description 常以空行或 `## Overview`
 * 开头，只取第一行会使清单中该行只剩工具名，
 * 模型无法据此判断是否需要 `load_tool`。
 */
function oneLine(text: string): string {
  const first = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '' && !line.startsWith('#'))
  if (first === undefined) return ''
  return first.length > SUMMARY_MAX_CHARS ? `${first.slice(0, SUMMARY_MAX_CHARS)}…` : first
}

/**
 * `process.platform` 的可读名称。
 *
 * 不要将 `process.platform` 原样写入提示词：它是 Node 的内部常量，
 * `win32` 会被理解为「Windows 32 位」，实测中模型曾据此向用户复述。
 * 未收录的取值原样返回：虚构名称的危害大于给出原值。
 */
function osName(platform: string): string {
  if (platform === 'win32') return 'Windows'
  if (platform === 'darwin') return 'macOS'
  if (platform === 'linux') return 'Linux'
  return platform
}

/** 待办状态的可读名称。 */
const TODO_LABEL: Record<TodoItem['status'], string> = {
  pending: '未开始',
  in_progress: '进行中',
  completed: '已完成',
}

const MEDIA_LABEL: Record<MediaOutput, string> = { image: '图像', video: '视频', audio: '音频' }

/** 提示词中指代参考素材的写法，以一行提供给大模型。序号按类别分别计数，顺序与 images / videos / audios 参数相同。 */
function mentionNote(style: MentionStyle): string {
  const kinds = MEDIA_OUTPUTS.flatMap((k) =>
    style[k]
      ? [
          `${MEDIA_LABEL[k]}写「${style[k].replaceAll('{n}', '1')}」「${style[k].replaceAll('{n}', '2')}」`,
        ]
      : [],
  )
  return `提示词中指代参考素材：${kinds.join('，')}，按类别分别计数，顺序与参数中的 images / videos / audios 相同`
}

/** 生成模型及其参数表。参数名是接口原生字段，原样写入 `params_json`。 */
function mediaModelsNote(models: MediaModelEntry[]): string {
  const sections: string[] = []
  for (const output of MEDIA_OUTPUTS) {
    const rows = models.filter((m) => m.output === output)
    if (!rows.length) continue
    const lines = [`### ${MEDIA_LABEL[output]} · ${MEDIA_TOOLS[output].name}`]
    for (const m of rows) {
      const spec = lookupMediaModel(m.model, m.kind)
      const ops = spec.operations.map(operationLabel).join('、')
      const limits = [
        spec.inputs.maxImages ? `参考图最多 ${spec.inputs.maxImages} 张` : '',
        spec.inputs.maxVideos ? `参考视频最多 ${spec.inputs.maxVideos} 个` : '',
        spec.inputs.maxAudios ? `参考音频最多 ${spec.inputs.maxAudios} 段` : '',
      ]
        .filter(Boolean)
        .join('、')
      lines.push(
        `- provider \`${m.provider}\`；model \`${m.model}\`${m.isDefault ? '（默认）' : ''}：${ops}${limits ? `，${limits}` : ''}`,
        ...(spec.mention ? [`  - ${mentionNote(spec.mention)}`] : []),
        ...spec.params.map((p) => `  - ${describeParam(p)}`),
      )
    }
    sections.push(lines.join('\n'))
  }
  return (
    `## 可用的生成模型（本次运行快照）\n${sections.join('\n\n')}\n\n` +
    'params_json 仅使用所选模型列出的参数，取值依据用户要求（尺寸、比例、清晰度、数量等）或自行判断，无需设置的参数省略；' +
    'provider 与 model 须取自同一行，两者均省略时使用默认模型。'
  )
}

/**
 * 生成一次 run 的非对话上下文快照。调用方只在 run 建立前调用一次并原子写入数据库；
 * 不得在每次 provider 请求前重新计算，否则同一 run 实际发出的字节会变化，重试与缓存均会出错。
 */
export function buildTailNotes(input: {
  workspaceRoot: string
  /** `process.platform` 的原值。可读名称由 `osName` 在此处转换，调用方无需预先转换。 */
  platform: string
  gitBranch?: string | null
  /**
   * 权限模式。必须告知模型：未告知时模型只能逐次试探，每次被拒绝都多消耗一轮
   * 「被拒 → 改写 → 重发」的 token，而被拒绝的工具调用本身也已计费。
   */
  mode: 'auto' | 'full'
  /** 技能索引：只含 name 与 description，正文由模型按需通过 read_skill 读取。 */
  skills?: { name: string; description: string }[]
  /** 记忆索引：只含 key 与首行摘要，正文由模型按需通过 read_memory 读取。 */
  memories?: { key: string; preview: string }[]
  /**
   * 顶层会话可分配的真实模型。只传入接口名与模型 id，不将 key、端点、headers 写入提示词。
   *
   * `undefined` = 本会话没有任务派发能力，不展示；空数组 = 有任务派发能力但当前未配置模型，
   * 两者不能合并，否则后者会导致模型无依据地生成一个名称。
   */
  models?: { provider: string; model: string }[]
  /**
   * 已配置的生成模型。只在注册了生成工具时传入：大模型据此选择模型、按参数表填写 `params_json`。
   * 参数表取自生成目录，与发送前的校验使用同一份数据，不会出现参数表列出而校验拒绝的情况。
   */
  mediaModels?: MediaModelEntry[]
  /** 当前项目的角色与本机识别到的外部 CLI。`undefined` = 本会话没有任务派发能力。 */
  team?: {
    roles: { id: string; name: string; description: string; provider?: string; model?: string }[]
    clis: { id: string; vendor: string; connected: boolean }[]
  }
  /** 本会话已有的子 agent。`undefined` = 本会话没有任务派发能力。 */
  subagents?: SubagentSummary[]
  /**
   * 待加载的外部工具：只含工具名与一句摘要，完整参数说明由模型按需通过 load_tool 加载。
   *
   * 该清单属于 run 快照，不能放入冻结 system 前缀：它随用户安装或卸载 MCP / 插件而变化。
   */
  externalTools?: { name: string; summary: string }[]
  /**
   * run 开始时会话账本中的待办快照。run 内的更新仍以真实的 `write_todos` 与绑定父待办的
   * `subagent` 调用和回执为准；压缩层保留这组最小事实链，不另建 Todo 状态。
   * 全部完成的清单属于上一项任务，只保留在历史中，不作为下一条指令的「当前待办」。
   */
  todos?: TodoItem[] | null
  /**
   * run 开始时本会话尚未完成的 workflow 投影。
   *
   * 压缩会将工具结果缩减为 320 字摘录，workflowId 与 checkpointId 可能完全不在其中；
   * 缺少本段时，模型没有续接该任务图的任何 id，只能重新派发整张图。
   * 事实来源仍是 step 账本，此处只将其重新提供给模型，不产生第二份可写状态。
   */
  workflows?: WorkflowProjection[]
}): TailNote[] {
  const today = new Date().toISOString().slice(0, 10)
  const lines = [
    `工作区：${input.workspaceRoot}`,
    `平台：${osName(input.platform)}`,
    `当前日期：${today}`,
  ]
  if (input.gitBranch) lines.push(`git 分支：${input.gitBranch}`)
  lines.push(
    input.mode === 'full'
      ? '权限模式：完全访问，不做裁决，也不设路径边界。'
      : '权限模式：auto，工作区外的写入与删除、修改系统状态的命令、读写凭证文件会被拒绝，其余放行。',
  )

  /*
   * 生成模型的参数表排在最前，工作区状态行在其后。快照与用户消息合并在同一条消息中，
   * 参数表若是最后一节，紧随其后的用户请求会被视为参数表的一部分：实测中模型回复「没有说要画什么」。
   */
  const notes: TailNote[] = [
    ...(input.mediaModels?.length
      ? [{ content: mediaModelsNote(input.mediaModels), group: 'workspaceState' as const }]
      : []),
    { content: lines.join('\n'), group: 'workspaceState' },
  ]

  /*
   * 模型清单放在动态快照中，不放在冻结 system 前缀中：设置页保存后，下一轮即应看到新配置，
   * 同一 run 内则必须保持不变。接口与模型始终分列：两者都允许自由文本，任何分隔符
   * 都可能出现在名称中，拼接为一个选择串后无法保证结构上无歧义。
   */
  if (input.models) {
    const list = input.models.length
      ? input.models
          .map((item) => `- provider 参数 \`${item.provider}\`；model 参数 \`${item.model}\``)
          .join('\n')
      : '- 当前没有配置可用模型；不要填写 provider 或 model 参数。'
    notes.push({
      content:
        `## 可分配给子 agent 的已配置模型（本次运行快照）\n${list}\n\n` +
        'provider 与 model 两个参数只接受清单中同一行的值；用户指定模型时填入这两个参数，写在任务正文中不生效。' +
        '用户提及的厂商、系列或简称（例如 glm）对应哪一行，按语义判断。',
      group: 'workspaceState',
    })
  }

  if (input.team) {
    const roles = input.team.roles.map(
      (role) =>
        `- 角色 id \`${role.id}\`：${role.name}${role.description ? `，${oneLine(role.description)}` : ''}；模型 ${
          role.provider && role.model ? `${role.provider} / ${role.model}` : '跟随会话'
        }`,
    )
    const clis = input.team.clis.map(
      (cli) =>
        `- 外部 CLI id \`${cli.id}\`：${cli.vendor}，本机进程，自带模型与账号，${cli.connected ? '已接入' : '未见凭证'}`,
    )
    const list = [...roles, ...clis].join('\n') || '- 当前项目没有角色，本机没有外部 CLI'
    notes.push({
      content:
        `## 当前项目的角色与外部 CLI（本次运行快照）\n${list}\n\n` +
        '新建子 agent 时 role 填写角色 id，cli 填写外部 CLI 的 id，逐字使用清单中的值。',
      group: 'workspaceState',
    })
  }
  if (input.subagents) {
    const list =
      input.subagents
        .map(
          (item) =>
            `- subagentId \`${item.id}\`：${item.name}，${SUBAGENT_KIND_LABEL[item.kind]}，模型 ${item.provider} / ${item.model}，${SUBAGENT_STATUS[item.status]}${
              item.resumable ? '' : '，不可续接：缺少会话号，再次派发时不保留上一轮上下文'
            }`,
        )
        .join('\n') || '- 本会话尚无子 agent'
    notes.push({
      content:
        `## 本会话的子 agent（本次运行快照）\n${list}\n\n` +
        '向已有子 agent 派发任务时，subagent 填写此处的 id，子 agent 在原上下文中继续执行。',
      group: 'workspaceState',
    })
  }

  //
  // 技能与记忆都只放标题：放入全部正文时，十余条即可占用数万 token，而一次任务
  // 通常只用到其中一两条。标题的成本与条数成正比而与内容无关，全部列出也能容纳；
  // 需要展开哪一条由模型根据标题判断：模型掌握当前任务的全部细节，
  // 而任何按当轮文本打分的召回只能衡量字面重合度。
  if (input.skills?.length) {
    const list = input.skills.map((s) => `- ${s.name}：${s.description}`).join('\n')
    notes.push({
      content: `## 可用技能（需要完整步骤时用 read_skill 读取）\n${list}`,
      group: 'skills',
    })
  }
  if (input.memories?.length) {
    const list = input.memories.map((m) => `- ${m.key}：${m.preview}`).join('\n')
    notes.push({
      content: `## 已记住的事实（需要正文时用 read_memory 读取）\n${list}`,
      group: 'memory',
    })
  }
  // 外部工具与技能、记忆的处理方式相同：清单常驻，参数说明按需加载。它归入 `mcpTools` 分组，
  // 与这些工具的 schema 同组：面板上「外部工具」一行显示的就是这部分开销。
  if (input.externalTools?.length) {
    const list = input.externalTools.map((t) => `- ${t.name}：${oneLine(t.summary)}`).join('\n')
    notes.push({
      content: `## 可加载的外部工具（调用前先用 load_tool 加载参数说明）\n${list}`,
      group: 'mcpTools',
    })
  }
  /*
   * 待办排在快照最后，便于审计同一 run 的输入顺序；这只是段内顺序，
   * 不产生第二份可写状态。
   */
  if (input.todos?.some((t) => t.status !== 'completed')) {
    const list = input.todos
      .map((t, i) => `${i + 1}. [${TODO_LABEL[t.status]}] ${t.content}`)
      .join('\n')
    notes.push({
      content: `## 当前待办清单（会话内最新一份，以此为准）\n${list}\n\n这是跨轮保留的任务进度，不是继续执行的指令。按本次用户要求决定是否接续；接续时先用 write_todos 提交清单并认领要执行的项。本轮认领且仍可执行的任务应继续完成。进度变化时报告，没有变化不重复报告。`,
      group: 'workspaceState',
    })
  }
  if (input.workflows?.length) {
    const list = input.workflows.map(workflowLine).join('\n')
    notes.push({
      content:
        `## 未完成的 workflow（本次运行快照）\n${list}\n\n` +
        '运行中的节点完成后，回执以消息形式送达本会话，不要为等待回执调用 workflow。' +
        '续接时用同一个 workflowId 与该图当前的 checkpointId 调用 workflow：' +
        'approve 进入下一批，revise 让指定的节点在其原有子会话中继续。' +
        '重新派发被中断的节点时写明「已完成则复述最终产出，否则继续执行」，中断之前的产出不在本快照中。',
      group: 'workspaceState',
    })
  }
  return notes
}

const SUBAGENT_STATUS: Record<SubagentSummary['status'], string> = {
  running: '进行中',
  idle: '空闲',
  failed: '上一轮未完成',
}

const WORKFLOW_PHASE: Record<WorkflowPhase, string> = {
  running: '执行中',
  waiting_review: '等待审查',
  completed: '已完成',
  failed: '已中断',
}

/** 每张未完成的任务图占一行，其后缩进列出每个 agent 节点的最近状态与是否可续接。 */
function workflowLine(projection: WorkflowProjection): string {
  const head = [
    `- workflowId=${projection.workflowId}`,
    `目标：${oneLine(projection.goal)}`,
    `状态：${WORKFLOW_PHASE[projection.phase]}`,
    ...(projection.checkpointId ? [`当前检查点：${projection.checkpointId}`] : []),
  ].join('｜')
  const nodes = projection.nodes
    .filter((node) => node.kind !== 'checkpoint')
    .map((node) => {
      const result = projection.results[node.id]
      if (!result) return `  - ${node.id}：尚无回执`
      const reason = result.error ? `：${oneLine(result.error)}` : ''
      const resumable = result.subagentId ? '，可续接原会话' : ''
      return `  - ${node.id}：${result.status}${reason}${resumable}`
    })
  return [head, ...nodes].join('\n')
}
