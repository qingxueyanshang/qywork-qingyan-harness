import { Show } from 'solid-js'
import { ConfigStatus } from './ConfigStatus.tsx'
import { config, configError, ensureConfig, patchConfig, reloadConfig } from './configStore.ts'
import { LoadState } from './LoadState.tsx'
import { Field } from './Row.tsx'

/**
 * 权限：agent 能读写哪些路径、哪些环境变量能透传给子进程。
 *
 * 审批模式（自动审批 / 完全访问）**不在这里**。它在输入区那个 chip 上——决定的是
 * 下一轮能不能不问就动手，和「用哪个模型」同一层，随时要改。搬进设置意味着改一次
 * 点四下，而且两处都能改同一个字段就是两本账。
 *
 * **沙箱也不在这里。** 沙箱是「命令跑在什么隔离里」，不是「准不准碰」——
 * 它的状态在左栏角落常驻，详情在「模块 → 终端」。这一页只回答权限。
 */
export function AccessSettings() {
  ensureConfig()

  return (
    <>
      <Show
        when={config()}
        fallback={<LoadState error={configError()} onRetry={() => void reloadConfig()} />}
      >
        {(c) => (
          <>
            {/* 两格合在一张卡里，**不开小标题**：页标题已经是「权限」，
                再来一行「agent 能碰到什么」就是同一件事写两遍。 */}
            <section class="settings-block">
              <div class="setting-rows">
                {/* 两句都是边界：不写第一句，填了相对路径要被 422 顶回来才知道；
                    不写第二句，用户会以为 full 只是不弹窗。
                    **`full` 下路径边界整个不设**（`session.ts` 传 `unrestrictedPaths`），
                    这里曾经写着「full 模式同样受限」，是一句反的。 */}
                <Field
                  label="工作区之外额外可读写的目录"
                  hint="只接受绝对路径 · full 模式下路径边界不生效"
                >
                  {/*
                    多行清单**用 blur 提交，不用 onInput**。
                    每次写都会立即切换运行中的配置，逐键写等于把「C:\」这种半截路径
                    一路发进去；而且一行还没敲完就被 trim 掉空行，光标会跳。
                  */}
                  <textarea
                    rows={3}
                    placeholder="一行一个绝对路径"
                    value={(c().additionalDirectories ?? []).join('\n')}
                    onBlur={(e) =>
                      void patchConfig({ additionalDirectories: lines(e.currentTarget.value) })
                    }
                  />
                </Field>

                <Field label="允许透传给子进程的环境变量" hint="留空用默认白名单">
                  <textarea
                    rows={3}
                    placeholder="一行一个变量名"
                    value={(c().envAllowList ?? []).join('\n')}
                    onBlur={(e) => void patchConfig({ envAllowList: lines(e.currentTarget.value) })}
                  />
                </Field>
              </div>
            </section>

            <ConfigStatus />
          </>
        )}
      </Show>
    </>
  )
}

function lines(v: string): string[] {
  return v
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}
