import { createResource, For, Show } from 'solid-js'
import { loaded } from '../../lib/resource.ts'
import { loadSkills } from '../../lib/store/index.ts'
import { LoadState } from './LoadState.tsx'
import { ScopeTag } from './ScopeBar.tsx'

/**
 * 技能。**全程只读。**
 *
 * 技能是一个目录（`SKILL.md` + 附带脚本），在网页上编辑一个目录需要一整套文件
 * 管理界面——那是编辑器该干的事。所以这里只回「装了哪些、在哪、说明是什么」，
 * 并把目录路径显示出来让人知道去哪儿改。写不了就说清写不了，不做一个只能改标题
 * 的假编辑器。
 *
 * 三层合并去重之后才是模型看到的那份，所以列的就是它，每条标一个层。
 */
export default function SkillsSettings() {
  const [data, { refetch }] = createResource(loadSkills)

  return (
    <Show
      when={loaded(data)}
      fallback={<LoadState error={data.error} onRetry={() => void refetch()} />}
    >
      {(d) => (
        <>
          <Show when={d().skills.length > 0}>
            <section class="settings-block">
              <ul class="mem-list">
                <For each={d().skills}>
                  {(s) => (
                    <li class="mem-item static">
                      <div class="mem-open">
                        <code class="mem-key">{s.name}</code>
                        <span class="mem-preview truncate">{s.description}</span>
                      </div>
                      <ScopeTag scope={s.scope} />
                    </li>
                  )}
                </For>
              </ul>
            </section>
          </Show>

          {/* 目录列出来是**功能前提**不是补充说明：装技能的唯一办法就是往这里放
              一个目录，不说清楚放哪儿，这一页就只能看不能用。 */}
          <section class="settings-block">
            <div class="settings-block-head">
              <h3>放这两个目录里的会被扫到</h3>
            </div>
            <div class="setting-rows">
              <For each={d().dirs}>
                {(x) => (
                  <div class="setting-row stack">
                    <div class="setting-row-text">
                      <span class="setting-row-label">
                        {x.scope === 'user' ? '用户级' : '全局'}
                      </span>
                    </div>
                    <code class="field-path">{x.dir}</code>
                  </div>
                )}
              </For>
            </div>
          </section>
        </>
      )}
    </Show>
  )
}
