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
 * **这一页是两件事，不是一件事的两种形态**：
 * - **角色**：持久定义，建子 agent 时按 id 引用。它的配置是提示词、模型与工具范围。
 * - **外部 CLI**＝本机装着的别家 agent 程序。它由探测得到，**没有配置面**——
 *   用户改不了「怎么调它」，那是厂商表的事（`packages/team/src/cli-detect.ts`）。
 *
 * 两者都能当编排节点的目标，但配置面毫不相干。把 CLI 当成「角色的一种运行位置」
 * 写进角色里，代价是建一条角色必须先懂后端这个概念。
 *
 * **这一页只列、只删，不改角色。** 角色写在 `team.json` 里：要改就改那个文件，或在会话里让模型改。
 * 删除仍走 `/api/team/raw` 一条路：读当前原文、去掉那一条、整份写回。
 *
 * **加一条角色走 /role 命令。** 「添加」把命令送进输入框，用户接着写描述，模型按这条明确要求建角色。
 *
 * **编排跟着仓库走。** 角色与编排图全是项目属性，跟到别的仓库去只会派错人。所以配置在工作区的
 * `.qy/team.json`，不在用户全局配置里。
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

  // `loaded()` 而不是 `file()`：存一次要把两个 resource 都重取，重取期间留住上一份。
  const text = () => loaded(file)?.raw ?? ''

  /** 当前原文解析出来的对象。解析不了回 null。 */
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
   * 改一次对象、整份写回、两个 resource 都重取。
   *
   * `mutate` 返回一句话表示这次改动被拒，返回 null 表示改成了。
   * **拒绝要在写盘之前**——落盘之后再报错，用户看到的是「报了错但也改了」。
   */
  const writeConfig = async (mutate: (cfg: TeamJson) => string | null) => {
    const cfg = config()
    if (cfg === null) {
      setError('team.json 解析失败，请修复后再使用表单')
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
   * 角色那一段的动作。**区头和空态框共用同一份**——两处各写一遍的话，
   * 迟早只改一处，而空的时候用户看到的是空态框里那一份。
   */
  const RoleActions = () => (
    <button class="btn-ghost sm" type="button" onClick={() => askInChat(`${ROLE_COMMAND} `)}>
      添加
    </button>
  )

  return (
    <>
      {/* 页头在 `Show` 外面：读取中和读取失败时这一页也该有名字。 */}
      <Show
        when={loaded(team)}
        fallback={<LoadState error={team.error} onRetry={() => void refetchTeam()} />}
      >
        {(t) => (
          <>
            {/* 配置坏了要说出来，不能静默当作「没配 team」——那在界面上等同于
                这个功能不存在。 */}
            <Show when={t().error}>{(e) => <p class="settings-notices bad">{e()}</p>}</Show>
            {/* 表单改的是这份原文解析出来的对象。读不到它而不说，下一次保存会把
                编排图与规则一起写没——所以这条失败必须显形，并给一条重试的路。 */}
            <Show when={file.error}>
              <LoadState error={file.error} onRetry={() => void refetchRaw()} />
            </Show>

            <Section title="角色" path={loaded(file)?.path ?? ''} actions={<RoleActions />}>
              <Show
                when={t().roles.length > 0}
                fallback={<EmptyBox label="还没有角色" actions={<RoleActions />} />}
              >
                <div class="entry-list">
                  <For each={t().roles}>
                    {(r) => (
                      <EntryCard
                        name={r.name}
                        desc={r.description}
                        actions={
                          <>
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
                          </>
                        }
                      />
                    )}
                  </For>
                </div>
              </Show>
            </Section>

            {/* 外部 CLI 这一段**没有增删改**：它整条来自本机探测。
                能显示的只有「装在哪、接没接入」，两样都不是用户在这里填的。 */}
            <Section title="外部 CLI" desc="本机独立进程，凭证与沙箱各自独立。">
              <Show
                when={loaded(clis)}
                fallback={<LoadState error={clis.error} onRetry={() => void refetchClis()} />}
              >
                {(c) => (
                  <Show
                    when={c().agents.length > 0}
                    fallback={<EmptyBox label="本机没有识别到外部 CLI" />}
                  >
                    <div class="entry-list">
                      <For each={c().agents}>
                        {(a) => (
                          <EntryCard
                            name={a.id}
                            desc={a.path}
                            badge={<span class="entry-tag">{a.vendor}</span>}
                          >
                            {/* 「接入」判的是见没见到凭证，不是真的跑通了——
                                真跑一次要花钱、要几十秒，而这是打开页面就该出的结果。 */}
                            <div class="entry-extra" classList={{ bad: !a.connected }}>
                              {a.connected ? '已接入' : '未见凭证'}
                            </div>
                          </EntryCard>
                        )}
                      </For>
                    </div>
                  </Show>
                )}
              </Show>
            </Section>

            {/* 删一条角色被拒时的原因。 */}
            <Show when={error()}>{(e) => <p class="settings-notices bad">{e()}</p>}</Show>
          </>
        )}
      </Show>
    </>
  )
}
