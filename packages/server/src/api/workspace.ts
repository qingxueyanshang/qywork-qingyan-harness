/** 项目：本机打开过的项目、添加项目，以及某个项目上安装的扩展。 */

import { mkdir, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type { ToolSpec } from '@qywork/agent'
import { MEDIA_OUTPUTS } from '@qywork/core'
import { configDir } from '@qywork/runtime'
import {
  archiveWorkspaceConversations,
  countConversations,
  createConversation,
  getWorkspaceByPath,
  listConversations,
  listWorkspaces,
  removeWorkspace,
  setWorkspacePinned,
  upsertWorkspace,
} from '@qywork/store'
import { type ApiHandler, json } from './types.ts'

/**
 * 未提供源文件夹时，默认工作区创建在此目录下。
 *
 * 与账本同根（`~/.qywork/`，可由 `QYWORK_HOME` 修改）：二者属于同一类数据，
 * 即本机上 qywork 自身的数据，卸载时一并移除。放在用户主目录下会多出一个
 * 无法判定能否删除的文件夹。需要打开时使用菜单中的「在资源管理器中打开」。
 */
function defaultWorkspacesRoot(): string {
  return join(configDir(), 'workspaces')
}

/** Windows 文件名中不允许出现的字符。斜杠与 `..` 另行判定。 */
const WINDOWS_RESERVED = '<>:"|?*'

/**
 * 项目名 → 文件夹名。不合法时返回 `null`，由调用方返回 422。
 *
 * 拒绝而不是清洗（CLAUDE.md E）：把 `../../etc` 清洗为 `etc` 时，界面上显示的名称
 * 与实际创建的目录不一致；创建到一半失败比当场拒绝更难排查。
 *
 * 逐字符判定控制字符，不写含控制字符的正则：这种正则要么在源码中放入裸控制字节，
 * 要么需要添加一条 biome-ignore，两者都没有必要。
 */
function folderNameFrom(name: string): string | null {
  if (!name || name === '.' || name === '..') return null
  if (/[/\\]/.test(name) || name.includes('..')) return null
  for (const ch of name) {
    if ((ch.codePointAt(0) ?? 0) < 32 || WINDOWS_RESERVED.includes(ch)) return null
  }
  // Windows 会静默去掉结尾的点与空格，写入磁盘的名称会与用户填写的不一致。
  if (/[. ]$/.test(name)) return null
  return name
}

/** 重名时添加后缀。不复用已有目录：该目录可能是上一个同名项目留下的内容。 */
async function freshDir(root: string, folder: string): Promise<string> {
  for (let i = 1; ; i++) {
    const candidate = join(root, i === 1 ? folder : `${folder}-${i}`)
    if (!(await stat(candidate).catch(() => null))) return candidate
  }
}

/**
 * 参数清单：只返回名称与是否必填，不下发整份 JSON Schema。
 *
 * MCP 工具的 schema 由第三方 server 决定，大小不受控：整份放入设置页的请求中，
 * 界面用不到，流量却随已安装的 server 波动。
 */
function paramsOf(schema: Record<string, unknown>): { name: string; required: boolean }[] {
  const props = schema.properties
  if (!props || typeof props !== 'object') return []
  const required = new Set(
    (Array.isArray(schema.required) ? schema.required : []).filter(
      (x): x is string => typeof x === 'string',
    ),
  )
  return Object.keys(props).map((name) => ({ name, required: required.has(name) }))
}

/**
 * 工具清单中的一行。`source` 由调用方给出：它表示工具的来源，规格本身不含这一信息。
 *
 * `actionKind` / `objectLabel` / `permissionEffect` 允许是函数：有的随参数变化
 * （多动作门面），有的随会话状态变化（`write_todos` 首次创建报「创建」、之后报「修改」）。
 * 不要无参调用它们：那会得到一个与实际不符的常量。因此如实报告「不固定」，
 * 而不是「随参数变化」：后者对随会话状态变化的工具不成立。
 */
function toolRow(s: Omit<ToolSpec, 'fn'>, source: string) {
  const VARIES = '不固定'
  return {
    name: s.name,
    category: s.category,
    facet: s.facet,
    objectLabel: typeof s.objectLabel === 'function' ? VARIES : s.objectLabel,
    summary: s.summary,
    actionKind: typeof s.actionKind === 'function' ? VARIES : s.actionKind,
    permissionEffect: typeof s.permissionEffect === 'function' ? VARIES : s.permissionEffect,
    params: paramsOf(s.parameters),
    source,
  }
}

export const handleWorkspaceApi: ApiHandler = async (url, req, d) => {
  const p = url.pathname

  if (p === '/api/workspaces') {
    /*
     * 添加项目。
     *
     * 同一路径既用于新增也用于切换：`upsertWorkspace` 在项目已存在时更新
     * `last_opened_at`，不存在时插入一行。为切换单开一个端点等于两条路径写同一个
     * 字段，而该字段正是分支监听与缺省 `?ws=` 的判据。
     *
     * 两种入参：
     *
     * - **提供 `path`**：只接受本机已存在的目录（CLAUDE.md E）。此处不做
     *   `git clone <URL>`：那等于从网络获取一段代码并在下次加载时运行。
     *   未提供 `name` 时取目录名。
     * - **只提供 `name`**：在 `~/.qywork/workspaces/<name>/` 下创建新目录。
     *   重名时添加后缀，不复用已有目录。
     *
     * 路径已在账本中时复用该行（`root_path` 是 UNIQUE），
     * `upsertWorkspace` 同时清除 `removed_at`：移除过的项目重新添加后，
     * 其会话随之恢复。会话关联的是 id，不是路径。
     *
     * 项目与首个会话在同一个事务中写入。响应同时返回当前会话列表，调用方无需在
     * upsert 之后再发一次列表请求，并为新项目另开一次写事务。
     */
    if (req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { path?: string; name?: string }
      const rawPath = body.path?.trim()
      const rawName = body.name?.trim()

      const activate = (path: string, name: string) =>
        d.store.tx(() => {
          const workspace = upsertWorkspace(d.store, path, name)
          const existing = listConversations(d.store, workspace.id)
          const conversations =
            existing.length > 0
              ? existing
              : [
                  createConversation(d.store, {
                    workspaceId: workspace.id,
                    // 未配置默认模型时留空：会话可以创建，发送在启动 run 前被 no_model 拦截，
                    // 界面引导用户在选择器中选择模型。
                    provider: d.config.active?.provider ?? '',
                    model: d.config.active?.model ?? '',
                  }),
                ]
          return { workspace, conversations }
        })

      if (rawPath) {
        const path = resolve(rawPath)
        const st = await stat(path).catch(() => null)
        if (!st?.isDirectory()) return json({ error: `不是本机已存在的目录：${path}` }, 422)
        /*
         * 名称的优先级：显式提供的 > 账本中已有的 > 目录名。
         *
         * 中间一档不能省略：切换到另一个项目同样经由此 upsert 且不带 name，
         * 省略后每切换一次，用户自定义的项目名都会被重置为目录名。
         */
        const known = getWorkspaceByPath(d.store, path)
        const name = rawName || known?.name || basename(path) || path
        const result = activate(path, name)
        // 该项目刚成为最近打开的项目，分支监听随之切换到该项目。
        d.watchGit()
        return json(result)
      }

      if (!rawName) return json({ error: '需提供 path 或 name' }, 422)
      const folder = folderNameFrom(rawName)
      if (!folder) {
        return json({ error: `该名称不能用作文件夹名：${rawName}` }, 422)
      }
      const root = defaultWorkspacesRoot()
      const path = await freshDir(root, folder)
      // 先创建目录再写账本：顺序相反时，创建失败会留下一条指向不存在目录的记录。
      await mkdir(path, { recursive: true })
      const result = activate(path, rawName)
      d.watchGit()
      return json(result)
    }
    /*
     * 每个项目附带会话数：项目卡片上需要显示。
     */
    return json({
      workspaces: listWorkspaces(d.store).map((w) => ({
        ...w,
        conversations: countConversations(d.store, w.id),
      })),
    })
  }

  /*
   * 把项目从列表中移除。不删除任何数据，见 `removeWorkspace`：
   * 它只设置 `removed_at` 标记，会话、消息、run 均不改动，重新添加同一路径即可恢复。
   *
   * 路径中的 id 直接作为 SQL 参数，不拼接路径也不拼接 SQL；查不到时返回 404 而不是静默成功。
   */
  const one = /^\/api\/workspaces\/([^/]+)$/.exec(p)
  if (one && req.method === 'DELETE') {
    const id = decodeURIComponent(one[1] as string)
    /*
     * 当前项目同样可以移除，只要还有其他项目可切换。
     *
     * 不要一律返回 409：那会拦截真实需求。开发本仓库时它本身就是当前项目，
     * 该行的 `⋯` 菜单中将永远没有「移除」，而先切换到其他项目再回来移除，
     * 是不应要求用户执行的操作顺序。
     *
     * 只有它是最后一个项目时才拒绝：移除后界面没有任何项目可服务，
     * 该状态没有终态。这一条仍是硬性规则。
     */
    if (id === d.workspaceId && listWorkspaces(d.store).length <= 1) {
      return json({ error: '这是最后一个项目，请先添加其他项目再移除' }, 409)
    }
    if (!removeWorkspace(d.store, id as never)) return json({ error: '项目不存在' }, 404)
    /*
     * 返回接下来应切换到的项目。客户端持有的 `?ws=` 指向刚被移除的项目，
     * 不提供去向时随后的每个请求都返回 404；由服务端直接给出，
     * 比在客户端各处补充移除后的跳转分支更简洁。
     */
    const next = listWorkspaces(d.store)[0]
    return json({ ok: true, ...(next ? { next: { id: next.id, rootPath: next.rootPath } } : {}) })
  }

  /*
   * 置顶与取消置顶。
   *
   * 使用 PATCH 而不是两个 POST（`/pin` + `/unpin`）：修改的是同一行上的同一个字段，
   * 两条路径写同一个字段即形成两本账。目标状态由 body 给出，而不是翻转当前状态：
   * 并发时翻转会得到错误的方向，且客户端无法安全重试。
   */
  if (one && req.method === 'PATCH') {
    const id = decodeURIComponent(one[1] as string)
    const body = (await req.json().catch(() => null)) as { pinned?: unknown } | null
    if (typeof body?.pinned !== 'boolean') return json({ error: '缺少 pinned（布尔）' }, 422)
    if (!setWorkspacePinned(d.store, id as never, body.pinned)) {
      return json({ error: '项目不存在，或已处于该状态' }, 404)
    }
    return json({ ok: true })
  }

  /*
   * 归档该项目当前的全部会话。
   *
   * 不删除数据：只从会话列表中移除，此后新建的会话照常显示（见
   * `archiveWorkspaceConversations`）。返回归档条数而不是 `{ok:true}`：
   * 界面需要显示归档了 N 条，「0 条」与「成功」在界面上必须能够区分。
   */
  const archive = /^\/api\/workspaces\/([^/]+)\/archive$/.exec(p)
  if (archive && req.method === 'POST') {
    const id = decodeURIComponent(archive[1] as string)
    return json({ archived: archiveWorkspaceConversations(d.store, id as never) })
  }

  // 本次请求所指的项目（`?ws=` 的解析结果，见 api/index.ts）。
  // 名称取目录名；无法取得时（根目录）回退到完整路径，不返回空串。
  if (p === '/api/workspace') {
    return json({
      id: d.workspaceId,
      root: d.workspaceRoot,
      name: basename(d.workspaceRoot) || d.workspaceRoot,
    })
  }

  /*
   * 本 agent 的能力清单：全部工具每行一条，附底层名、参数、动作与权限。
   *
   * 本接口是分类维度（`ToolCategory`）的消费者。缺少它时该维度即为 C1 第 1 款所述的
   * 未接通链路：注册时校验、schema 中声明，但没有任何读取方。
   *
   * 三个来源，以 `source` 区分：内置工具取自注册表（无额外开销，即真源本身）；
   * 插件与 MCP 的工具均取自 `toolSpecs`：加载扩展时已连接全部插件进程与 server，
   * 这两份清单是该次连接的产物，列出它们没有额外开销。取的是注册成功的工具，
   * 而不是清单中声明的工具：本页回答当前能调用哪些工具，已安装但无法启动的不计入。
   *
   * 归属按注册名前缀反查，前缀必须由 `pluginToolPrefix` / `toolNamePrefix` 生成：
   * 注册名经过规范化（`my.server` → `mcp__my_server__x`），按原名拼接无法匹配任何工具。
   *
   * 扩展使用引用计数，与 release 配对：直接调用 `loadExtensions` 会为每次请求启动一批新的
   * 插件与 MCP 子进程且无人关闭。异常路径同样需要 release，因此使用 try/finally。
   */
  if (p === '/api/tools') {
    const { ToolRegistry, TOOL_CATEGORIES } = await import('@qywork/agent')
    const { registerBuiltinTools, LOAD_TOOL_SPEC } = await import('@qywork/tools')
    const { acquireExtensions, releaseExtensions, pluginToolPrefix, toolNamePrefix } = await import(
      '@qywork/runtime'
    )

    const registry = new ToolRegistry()
    // 设置页列出各通道的完整工具目录；会话实际可用的工具仍由端口与配置决定。
    registerBuiltinTools(registry, {
      mcpConfig: true,
      plugins: true,
      browser: true,
      desktop: true,
      canvas: true,
      office: true,
      delegate: true,
      media: MEDIA_OUTPUTS,
    })
    /*
     * `load_tool` 需要手动补入一行：它只在会话建立待加载池时注册，不在 `registerBuiltinTools`
     * 中，此处新建的注册表无法列出它。不要在此处重新计算分档（统计 schema 总量、超过阈值才列出）：
     * 该判断的真源在建立待加载池处，计算两次即形成两本账。因此此处使用不带实现的规格，
     * 「只在超过阈值时注册」这条边界写在它的用途中。
     */
    const rows = [...registry.list(), LOAD_TOOL_SPEC].map((s) => toolRow(s, 'builtin'))

    const ext = await acquireExtensions(d.workspaceRoot)
    try {
      for (const plugin of ext.plugins.plugins) {
        const prefix = pluginToolPrefix(plugin.manifest.id)
        for (const spec of ext.plugins.toolSpecs) {
          if (spec.name.startsWith(prefix)) rows.push(toolRow(spec, `plugin:${plugin.manifest.id}`))
        }
      }
      for (const server of ext.mcp.servers) {
        const prefix = toolNamePrefix(server.name)
        for (const spec of ext.mcp.toolSpecs) {
          if (spec.name.startsWith(prefix)) rows.push(toolRow(spec, `mcp:${server.name}`))
        }
      }

      // 确定性排序：类目按枚举顺序，其后按功能方向与用途字典序。
      rows.sort(
        (a, b) =>
          TOOL_CATEGORIES.indexOf(a.category) - TOOL_CATEGORIES.indexOf(b.category) ||
          a.facet.localeCompare(b.facet, 'zh') ||
          a.summary.localeCompare(b.summary, 'zh'),
      )
      return json({ tools: rows })
    } finally {
      await releaseExtensions(ext)
    }
  }

  return null
}
