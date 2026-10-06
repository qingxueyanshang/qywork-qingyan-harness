import { For, Show } from 'solid-js'
import { renderMarkdown } from '../../lib/markdown.ts'
import { configNotices, configProblems, configWriteError } from './configStore.ts'

/**
 * 当前配置的三类状态。三者都是不显示就会导致用户误判的事实，因此显示在设置页中，
 * 而不是只在终端输出：桌面端用户不会运行 `qy config`。
 *
 * 1. `writeError`：最近一次写入失败。没有「保存」按钮时失败必须主动显示：
 *    每修改一个字段即写入一次，成功时无需反馈（值已显示在界面上）；失败时若不提示，界面显示的
 *    仍是用户刚选择的值，而写入磁盘的是旧值。
 * 2. `problems`：服务端 `diagnoseConfig` 的诊断（例如 active 指向的档案未配置 key）。
 *    它表示当前配置的状态，与最近一次写入是两件不同的事，两者均显示但不合并。
 * 3. `notices`：`configNotices` 的提醒，即不阻断运行但每次都需要告知的事实
 *    （放行了工作区之外的目录、模型不在内置目录因而计价为 0、sandboxNetwork
 *    在本机未生效）。这一类必须渲染：服务端已发送、store
 *    也已接收，界面上若无代码读取，这些已配置但未生效的情况
 *    桌面端用户一项都看不到。
 *
 * 按 markdown 渲染：这几段内容是 markdown（`configNotices` 的注释中写明了两个
 * 显示位置共用一份文案），按纯文本显示会出现大量星号，且列表被合并为一行。
 */
export function ConfigStatus() {
  return (
    <>
      <Show when={configWriteError()}>{(msg) => <div class="settings-error">{msg()}</div>}</Show>
      <Show when={configProblems().length}>
        <div class="settings-notices bad">
          <For each={configProblems()}>
            {(p) => <div class="markdown" innerHTML={renderMarkdown(p)} />}
          </For>
        </div>
      </Show>
      <Show when={configNotices().length}>
        <div class="settings-notices">
          <For each={configNotices()}>
            {(n) => <div class="markdown" innerHTML={renderMarkdown(n)} />}
          </For>
        </div>
      </Show>
    </>
  )
}
