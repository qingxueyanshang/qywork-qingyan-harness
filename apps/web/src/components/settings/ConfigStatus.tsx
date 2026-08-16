import { For, Show } from 'solid-js'
import { renderMarkdown } from '../../lib/markdown.ts'
import { configNotices, configProblems, configWriteError } from './configStore.ts'

/**
 * 当前配置的三类状态。**都是「不说用户就会被骗」的那种事实**，所以摆在设置页里，
 * 而不是只在终端打印——桌面端用户不会去跑 `qy config`。
 *
 * 1. `writeError`：刚才那一下写失败了。没有「保存」按钮之后**失败必须自己现身**——
 *    改一格就写一次，成功时不需要反馈（值就在那儿），失败时不说的话，界面显示的
 *    还是用户刚点的值，而落盘的是旧值。
 * 2. `problems`：服务端 `diagnoseConfig` 的诊断（比如 active 指向的档案没配 key）。
 *    这是**当前配置的状态**，和「刚才那一下」是两回事，两个都显示但不合并。
 * 3. `notices`：`configNotices` 的提醒——不阻断运行、但每次都要说的事实
 *    （放开了工作区之外的目录、模型不在内置目录所以计价按 0、sandboxNetwork
 *    在本机没生效、权限模式是 full）。**这一条必须渲染出来**：服务端发了、store
 *    也收了，界面上没人读的话，恰恰是「配了以为生效、其实没生效」的那几件事，
 *    桌面端用户一件都看不到。
 *
 * 按 markdown 渲染：这几段本来就是 markdown（`configNotices` 的注释里写明了两个
 * 落点共用一份文案），当纯文本贴出来就是满屏星号和挤成一行的列表。
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
