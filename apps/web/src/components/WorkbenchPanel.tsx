/**
 * 工作台页：在沙箱 iframe 中加载插件提供的页面，并为页面提供桥接。
 *
 * iframe 不带 `allow-same-origin`：页面是插件编写的代码，取得不透明源后无法读取界面的存储与令牌，
 * 也无法直接请求 `/api/`。页面需要的能力只经下面的桥接提供，桥接只有三项：
 *
 * - `tool.call`：调用本插件声明的工具，与模型调用使用同一个插件进程与同一套宿主权限检查；
 * - `panel.open`：在右侧面板打开工作区中的文件，与点击回复中的文件链接相同；
 * - `composer.insert`：把文字放入输入框，由用户决定是否发送。
 *
 * 协议：页面 `parent.postMessage({ type: 'qywork', id, method, params }, '*')`，
 * 界面以 `{ type: 'qywork', id, ok, result }` 或 `{ type: 'qywork', id, ok: false, error }` 回复。
 * 只接受来自本页 iframe 的消息（按 `event.source` 判定）。
 */

import { createMemo, onCleanup, onMount, Show } from 'solid-js'
import {
  askInChat,
  callWorkbenchTool,
  explainApiError,
  openFileInPanel,
  refreshWorkbenches,
  workbenches,
  workbenchKey,
  workbenchUrl,
} from '../lib/store/index.ts'

interface BridgeRequest {
  type: 'qywork'
  id: unknown
  method: unknown
  params?: unknown
}

function isRequest(v: unknown): v is BridgeRequest {
  return typeof v === 'object' && v !== null && (v as { type?: unknown }).type === 'qywork'
}

export default function WorkbenchPanel(props: { workbench: string }) {
  let frame: HTMLIFrameElement | undefined
  const entry = createMemo(
    () => workbenches().find((w) => workbenchKey(w) === props.workbench) ?? null,
  )

  // 刷新后列表为空：页签已恢复，但页面地址中的随机段需重新取得。
  onMount(() => {
    if (!entry()) void refreshWorkbenches().catch(() => undefined)
  })

  const handle = async (req: BridgeRequest): Promise<unknown> => {
    const w = entry()
    if (!w) throw new Error('工作台已卸载')
    const params = (
      typeof req.params === 'object' && req.params !== null ? req.params : {}
    ) as Record<string, unknown>
    if (req.method === 'tool.call') {
      if (typeof params.tool !== 'string') throw new Error('tool.call 需要 tool')
      const args = typeof params.args === 'object' && params.args !== null ? params.args : {}
      return callWorkbenchTool(w.plugin, params.tool, args as Record<string, unknown>)
    }
    if (req.method === 'panel.open') {
      if (typeof params.path !== 'string') throw new Error('panel.open 需要 path')
      openFileInPanel(params.path)
      return null
    }
    if (req.method === 'composer.insert') {
      if (typeof params.text !== 'string') throw new Error('composer.insert 需要 text')
      askInChat(params.text)
      return null
    }
    throw new Error(`未知的方法：${String(req.method)}`)
  }

  const onMessage = (e: MessageEvent) => {
    if (!frame || e.source !== frame.contentWindow || !isRequest(e.data)) return
    const req = e.data
    const reply = (body: Record<string, unknown>) =>
      frame?.contentWindow?.postMessage({ type: 'qywork', id: req.id, ...body }, '*')
    handle(req).then(
      (result) => reply({ ok: true, result }),
      (err: unknown) => reply({ ok: false, error: explainApiError(err, '调用失败') }),
    )
  }
  window.addEventListener('message', onMessage)
  onCleanup(() => window.removeEventListener('message', onMessage))

  return (
    <div class="workbench-pane">
      <Show when={entry()} keyed>
        {(w) => (
          <iframe
            ref={frame}
            class="workbench-frame"
            title={w.title}
            src={workbenchUrl(w)}
            sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
          />
        )}
      </Show>
    </div>
  )
}
