import { createResource, createSignal, For, Show } from 'solid-js'
import { loaded } from '../../lib/resource.ts'
import { loadSkills, type Scope } from '../../lib/store/index.ts'
import { LoadState } from './LoadState.tsx'
import { EmptyBox, EntryCard, PageHead, Section } from './Page.tsx'
import { ScopeTabs, ShadowTag } from './Scope.tsx'

/**
 * 技能。**全程只读。**
 *
 * 技能是一个目录（`SKILL.md` + 附带脚本），在网页上编辑一个目录需要一整套文件
 * 管理界面——那是编辑器该干的事。所以这里只回「装了哪些、在哪、说明是什么」，
 * 并把目录路径显示出来让人知道去哪儿改。写不了就说清写不了，不做一个只能改标题
 * 的假编辑器。
 *
 * 目录路径挂在标签页那一行：装技能的唯一办法就是往那个目录里放一个子目录，
 * 不说清楚放哪儿，这一页就只能看不能用。
 */
/** 技能目录的最后一段。技能的绝对路径太长，卡里只放这一段。 */
function dirName(dir: string): string {
  return dir.split(/[\\/]/).pop() ?? dir
}

export default function SkillsSettings() {
  const [data, { refetch }] = createResource(loadSkills)
  const [scope, setScope] = createSignal<Scope>('project')

  const rows = () => loaded(data)?.skills.filter((s) => s.scope === scope()) ?? []

  return (
    <>
      {/* 页头在 `Show` 外面：读取中和读取失败时这一页也该有名字。 */}
      <PageHead
        title="技能"
        desc="技能是按需加载的操作步骤：索引每轮都发，正文由模型自己拉。放一个目录进去即可，这一页只读。"
      />
      <Show
        when={loaded(data)}
        fallback={<LoadState error={data.error} onRetry={() => void refetch()} />}
      >
        {(d) => (
          <>
            <ScopeTabs value={scope()} onChange={setScope} dirs={d().dirs} />

            <Section>
              <Show when={rows().length > 0} fallback={<EmptyBox label="这一层还没有技能" />}>
                <div class="entry-list">
                  <For each={rows()}>
                    {(s) => (
                      <EntryCard
                        name={s.name}
                        desc={s.description}
                        badge={<Show when={s.shadowedBy}>{(by) => <ShadowTag by={by()} />}</Show>}
                      >
                        {/* 目录名和技能名多数时候是同一个（`name` 取自 frontmatter，
                            缺省回落成目录名）。只在两者不同时才显示——一样时它是把
                            同一个词写两遍。整条绝对路径不进卡：这一层的目录已经写在
                            标签页那一行了，卡里再来一条只会把说明挤成配角。 */}
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
          </>
        )}
      </Show>
    </>
  )
}
