import { Show } from 'solid-js'
import { renderMarkdown } from '../../lib/markdown.ts'
import { state } from '../../lib/store/index.ts'
import { ConfigStatus } from './ConfigStatus.tsx'
import { config, configError, ensureConfig, patchConfig, reloadConfig } from './configStore.ts'
import { LoadState } from './LoadState.tsx'
import { Field } from './Row.tsx'

/**
 * 权限与沙箱：**agent 能碰到什么**。
 *
 * 审批模式（自动审批 / 完全访问）**不在这里**。它在输入区那个 chip 上——决定的是
 * 下一轮能不能不问就动手，和「用哪个模型」同一层，随时要改。搬进设置意味着改一次
 * 点四下，而且两处都能改同一个字段就是两本账。
 *
 * 沙箱状态从左栏角落那行小字挪了一份**到这里**，不是复制：左栏那行是常驻警示
 * （没有沙箱是危险的默认，必须一眼看到），这里是它的详情落点——`reason` 那句话
 * 在左栏只能塞进 title 属性，鼠标不悬停就看不到。
 */
export function AccessSettings() {
  ensureConfig()
  const sandbox = () => state.capabilities?.sandbox ?? null

  return (
    <>
      <section class="settings-block">
        <h3 class="settings-block-head">沙箱</h3>
        <Show when={sandbox()} fallback={<div class="settings-loading">读取中…</div>}>
          {(sb) => (
            <div class="setting-rows">
              <div class="setting-row stack" classList={{ warn: !sb().active }}>
                <span class="setting-row-label">
                  {sb().active ? `已启用 · ${sb().backend}` : '无内核沙箱'}
                </span>
                {/* 这句在左栏只能塞 title，鼠标不悬停就看不到——而「为什么没有沙箱」
                    恰恰是用户唯一需要读全的一句。

                    **按 markdown 渲染**：服务端那段 reason 本来就是 markdown，
                    当纯文本贴出来就是满屏的星号。 */}
                <div
                  class="setting-row-hint markdown"
                  innerHTML={renderMarkdown(sb().reason ?? '')}
                />
              </div>
            </div>
          )}
        </Show>
      </section>

      <Show
        when={config()}
        fallback={<LoadState error={configError()} onRetry={() => void reloadConfig()} />}
      >
        {(c) => (
          <>
            {/* 两格合在一张卡里，**不各自开一节**。
                原来是「路径边界」下面挂一个「工作区之外额外可读写的目录」——
                两级标题说的是同一件事，中间那一级只是噪声。 */}
            <section class="settings-block">
              <h3 class="settings-block-head">agent 能碰到什么</h3>
              <div class="setting-rows">
                {/* 两句都是边界，不是解释：不写第一句会被 422 顶回来才知道，
                    不写第二句用户会以为切到 full 就不受限了。 */}
                <Field label="工作区之外额外可读写的目录" hint="只接受绝对路径 · full 模式同样受限">
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
