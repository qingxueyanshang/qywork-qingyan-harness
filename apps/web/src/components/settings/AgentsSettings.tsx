import { ROLE_COMMAND } from '@qywork/core'
import { createResource, createSignal, For, Show } from 'solid-js'
import { loaded } from '../../lib/resource.ts'
import {
  askInChat,
  loadTeam,
  loadTeamClis,
  loadTeamRaw,
  saveTeamRaw,
} from '../../lib/store/index.ts'
import { IconTrash } from '../Icons.tsx'
import { LoadState } from './LoadState.tsx'
import { EmptyBox, EntryCard, Section } from './Page.tsx'

/**
 * Agent Team。
 *
 * 本页包含两类互不相关的对象：
 * - 角色：持久定义，创建子 agent 时按 id 引用。其配置为提示词、模型与工具范围。
 * - 外部 CLI：本机安装的其他厂商的 agent 程序。它由探测得到，没有可配置项：
 *   调用方式由厂商表决定（`packages/team/src/cli-detect.ts`），用户无法修改。
 *
 * 两者都能作为编排节点的目标，但配置项互不相关。若把 CLI 作为角色的一种运行位置
 * 写入角色，创建角色时就必须先理解后端这一概念。
 *
 * 本页只列出和删除角色，不修改角色。角色保存在 `team.json` 中：修改时直接编辑该文件，或在会话中由模型修改。
 * 删除只经由 `/api/team/raw`：读取当前原文、删除对应条目、整体写回。
 *
 * 添加角色使用 /role 命令。「添加」把命令填入输入框，用户继续输入描述，模型按该明确要求创建角色。
 *
 * 编排配置随仓库保存。角色与编排图均为项目属性，带到其他仓库会派发给错误的角色。因此配置位于工作区的
 * `.qy/team.json`，不在用户全局配置中。
 */

interface RoleJson {
  id?: string
  name?: string
  description?: string
  systemPrompt?: string
  provider?: string
  model?: string
}
interface TeamJson {
  roles?: RoleJson[]
  plan?: unknown[]
  rules?: unknown
}

export default function AgentsSettings() {
  const [team, { refetch: refetchTeam }] = createResource(loadTeam)
  const [clis, { refetch: refetchClis }] = createResource(loadTeamClis)
  const [file, { refetch: refetchRaw }] = createResource(loadTeamRaw)
  const [error, setError] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)

  // 使用 `loaded()` 而不是 `file()`：每次保存后两个 resource 均需重新获取，重新获取期间保留上一份数据。
  const text = () => loaded(file)?.raw ?? ''

  /** 当前原文解析出的对象。无法解析时返回 null。 */
  const config = (): TeamJson | null => {
    const body = text().trim()
    if (!body) return {}
    try {
      const parsed: unknown = JSON.parse(body)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
      return parsed as TeamJson
    } catch {
      return null
    }
  }

  /**
   * 修改对象、整体写回，并重新获取两个 resource。
   *
   * `mutate` 返回一句说明表示本次修改被拒绝，返回 null 表示修改成功。
   * 拒绝必须发生在写入磁盘之前：写入后再报错，结果是报告失败但修改已经生效。
   */
  const writeConfig = async (mutate: (cfg: TeamJson) => string | null) => {
    const cfg = config()
    if (cfg === null) {
      setError('team.json 解析失败，请修复后重试')
      return
    }
    const refused = mutate(cfg)
    if (refused) {
      setError(refused)
      return
    }
    setBusy(true)
    try {
      await saveTeamRaw(`${JSON.stringify(cfg, null, 2)}\n`)
      setError(null)
      await Promise.all([refetchRaw(), refetchTeam()])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /**
   * 角色区段的操作按钮。区段标题与空状态框共用同一份定义：两处分别编写时，
   * 修改时容易只改一处，而列表为空时用户看到的是空状态框中的那一份。
   */
  const RoleActions = () => (
    <button class="btn-ghost sm" type="button" onClick={() => askInChat(`${ROLE_COMMAND} `)}>
      添加
    </button>
  )

  return (
    <Show
      when={loaded(team)}
      fallback={<LoadState error={team.error} onRetry={() => void refetchTeam()} />}
    >
      {(t) => (
        <>
          {/* 配置损坏时必须显示错误，不能静默按未配置 team 处理：那在界面上等同于
                该功能不存在。 */}
          <Show when={t().error}>{(e) => <p class="settings-notices bad">{e()}</p>}</Show>
          {/* 表单修改的是这份原文解析出的对象。无法读取它而不提示时，下一次保存会把
                编排图与规则一并清空，因此这条失败必须显示，并提供重试入口。 */}
          <Show when={file.error}>
            <LoadState error={file.error} onRetry={() => void refetchRaw()} />
          </Show>

          <Section title="角色" path={loaded(file)?.path ?? ''} actions={<RoleActions />}>
            <Show
              when={t().roles.length > 0}
              fallback={<EmptyBox label="没有角色" actions={<RoleActions />} />}
            >
              <div class="entry-list">
                <For each={t().roles}>
                  {(r) => (
                    <EntryCard
                      name={r.name}
                      desc={r.description}
                      actions={
                        <button
                          class="icon-btn"
                          type="button"
                          aria-label={`删除角色 ${r.name}`}
                          data-tip="删除"
                          disabled={busy()}
                          onClick={() =>
                            void writeConfig((cfg) => {
                              cfg.roles = (cfg.roles ?? []).filter((x) => x.id !== r.id)
                              return null
                            })
                          }
                        >
                          <IconTrash size={13} />
                        </button>
                      }
                    />
                  )}
                </For>
              </div>
            </Show>
          </Section>

          {/* 外部 CLI 区段不提供增删改：其内容全部来自本机探测。
                可显示的只有安装位置与接入状态，两者都不由用户在此填写。 */}
          <Section title="外部 CLI" desc="本机独立进程，凭证与沙箱各自独立。">
            <Show
              when={loaded(clis)}
              fallback={<LoadState error={clis.error} onRetry={() => void refetchClis()} />}
            >
              {(c) => (
                <Show
                  when={c().agents.length > 0}
                  fallback={<EmptyBox label="本机未识别到外部 CLI" />}
                >
                  <div class="entry-list">
                    <For each={c().agents}>
                      {(a) => (
                        <EntryCard
                          name={a.id}
                          desc={a.path}
                          badge={<span class="entry-tag">{a.vendor}</span>}
                        >
                          {/* 「接入」判断的是是否检测到凭证，而不是实际执行是否成功：
                                实际执行一次需要付费且耗时数十秒，而该结果应在打开页面时即给出。 */}
                          <div class="entry-extra" classList={{ bad: !a.connected }}>
                            {a.connected ? '已检测到凭据' : '未见凭证'}
                          </div>
                        </EntryCard>
                      )}
                    </For>
                  </div>
                </Show>
              )}
            </Show>
          </Section>

          {/* 删除角色被拒绝时的原因。 */}
          <Show when={error()}>{(e) => <p class="settings-notices bad">{e()}</p>}</Show>
        </>
      )}
    </Show>
  )
}
