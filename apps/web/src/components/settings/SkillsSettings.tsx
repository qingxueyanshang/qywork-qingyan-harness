import { createResource, createSignal, For, Show } from 'solid-js'
import { loaded } from '../../lib/resource.ts'
import {
  askInChat,
  deleteSkill,
  extensionsRevision,
  importSkill,
  isDesktopShell,
  loadSkills,
  pickFiles,
  pickWorkspace,
  type Scope,
  workspace,
} from '../../lib/store/index.ts'
import { IconTrash } from '../Icons.tsx'
import { LoadState } from './LoadState.tsx'
import { EmptyBox, EntryCard, Section } from './Page.tsx'
import { ScopeTabs, ShadowTag } from './Scope.tsx'
import { newSkillPrompt } from './ScopePrompts.ts'

/**
 * 技能。
 *
 * 支持新增、导入与删除，不在此处编辑正文。新增交给会话中的模型，由 `write_skill` 写入，
 * `description` 的必填校验也在该工具中。一个技能至少包含 `<目录>/SKILL.md`。技能目录中可以包含
 * 脚本与附件，在网页上编辑目录需要完整的文件管理功能，属于编辑器的职责。
 * 因此卡片上给出目录名，正文在编辑器中修改。
 *
 * 按层分列：本页首先要回答「该技能属于当前仓库还是全局生效」。
 * 被高优先级层同名覆盖的条目仍列在各自所属的层中，并附一个 `ShadowTag`。
 */

/** 技能目录的最后一段。删除与定位修改位置都以它为准，而不是前置元信息中的 name。 */
function dirName(dir: string): string {
  return dir.split(/[\\/]/).pop() ?? dir
}

export default function SkillsSettings() {
  const [data, { refetch }] = createResource(
    () => [workspace()?.id, extensionsRevision()],
    loadSkills,
  )
  const [scope, setScope] = createSignal<Scope>('project')
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [okMsg, setOkMsg] = createSignal<string | null>(null)

  const rows = () => loaded(data)?.skills.filter((s) => s.scope === scope()) ?? []

  const run = async (fn: () => Promise<string | null>) => {
    setBusy(true)
    setError(null)
    setOkMsg(null)
    try {
      const msg = await fn()
      if (msg) setOkMsg(msg)
      // 导入或删除后立即重新读取：列表不刷新时界面显示为未生效，用户会重复操作。
      await refetch()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const doImport = (path: string) =>
    void run(async () => {
      const r = await importSkill(scope(), path)
      return r.installed
        .map((s) => `已导入 ${s.name}${s.active ? '' : `，当前生效的是 ${s.effective.scope} 层`}`)
        .join('；')
    })

  /**
   * 本页的动作按钮。路径所在行与空状态框共用同一份定义：两处分别实现时，
   * 修改容易遗漏一处，而列表为空时用户看到的是空状态框中的那一份。
   */
  const Actions = () => (
    <>
      {/* 导入仅在桌面外壳中提供：网页中没有系统文件选择器，
          不显示点击后无响应的按钮（B5）。 */}
      <Show when={isDesktopShell()}>
        <button class="btn-ghost sm" type="button" disabled={busy()} onClick={() => void browse()}>
          导入目录
        </button>
        <button
          class="btn-ghost sm"
          type="button"
          disabled={busy()}
          onClick={() => void browseZip()}
        >
          导入 ZIP
        </button>
      </Show>
      <button class="btn-ghost sm" type="button" onClick={() => askInChat(newSkillPrompt(scope()))}>
        新增
      </button>
    </>
  )

  /** 选择本机已存在的技能目录，选定后立即导入。 */
  const browse = async () => {
    if (!isDesktopShell()) return
    setError(null)
    setOkMsg(null)
    try {
      const picked = await pickWorkspace()
      if (picked) doImport(picked)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const browseZip = async () => {
    try {
      const path = (await pickFiles())[0]
      if (path) doImport(path)
    } catch (error) {
      setError(String(error))
    }
  }

  return (
    <Show
      when={loaded(data)}
      fallback={<LoadState error={data.error} onRetry={() => void refetch()} />}
    >
      {(d) => (
        <>
          <ScopeTabs
            value={scope()}
            onChange={(s) => {
              setScope(s)
              // 切换层即切换目录，上一层的操作结果不属于新的层。
              setError(null)
              setOkMsg(null)
            }}
            dirs={d().dirs}
            actions={<Actions />}
          />

          <Section>
            <Show
              when={rows().length > 0}
              fallback={<EmptyBox label="暂无技能" actions={<Actions />} />}
            >
              <div class="entry-list">
                <For each={rows()}>
                  {(s) => (
                    <EntryCard
                      name={s.name}
                      desc={s.description}
                      badge={<Show when={s.shadowedBy}>{(by) => <ShadowTag by={by()} />}</Show>}
                      actions={
                        <button
                          class="icon-btn"
                          type="button"
                          aria-label={`删除技能 ${s.name}`}
                          data-tip="删除"
                          disabled={busy()}
                          onClick={() =>
                            void run(async () => {
                              await deleteSkill(dirName(s.dir), s.scope)
                              return null
                            })
                          }
                        >
                          <IconTrash size={13} />
                        </button>
                      }
                    >
                      {/* 目录名与技能名通常相同（`name` 取自前置元信息，
                            缺省时使用目录名）。仅在两者不同时显示，相同时会重复
                            同一个词。卡片中不显示完整绝对路径：该层的目录已显示在
                            标签页所在行。 */}
                      <Show when={dirName(s.dir) !== s.name}>
                        <div class="entry-extra">
                          目录 <code>{dirName(s.dir)}</code>
                        </div>
                      </Show>
                    </EntryCard>
                  )}
                </For>
              </div>
            </Show>
          </Section>

          {/* 导入与删除的结果显示在此处。`when` 组合多个条件时，值必须放在末位：
                `Show` 将求值结果原样传给子函数，布尔值 `true` 会渲染为空框。 */}
          <Show when={error()}>{(e) => <p class="settings-notices bad">{e()}</p>}</Show>
          <Show when={okMsg()}>{(m) => <p class="settings-notices">{m()}</p>}</Show>
        </>
      )}
    </Show>
  )
}
