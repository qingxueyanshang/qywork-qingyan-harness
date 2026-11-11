/**
 * 输入框顶部的后台命令栏。
 *
 * 覆盖范围（B6）：`BackgroundCommands.tsx`、`store/connection.ts` 对 `commands.changed` 的折叠、
 * `store/actions.ts` 的 `stopBackgroundCommand`、`store/state.ts` 的 `composerStackAbove`。
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
})
afterEach(() => {
  document.body.replaceChildren()
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

function click(button: HTMLButtonElement) {
  const event = new MouseEvent('click', { bubbles: true })
  const delegated = (button as unknown as { $$click?: (event: MouseEvent) => void }).$$click
  if (delegated) {
    delegated.call(button, event)
    return
  }
  button.dispatchEvent(event)
}

test('当前会话的快照每条命令一行，点击停止发送 command.stop；其他会话的快照不显示', async () => {
  const { render } = await import('solid-js/web')
  const store = await import('../lib/store/index.ts')
  const { BackgroundCommands } = await import('./BackgroundCommands.tsx')
  store.setState({ activeConversation: 'cv_bg', backgroundCommands: [] })
  store.openView('cv_bg')
  const snapshot = (conversationId: string, commands: { id: string; command: string }[]) =>
    store.applyEvent({
      seq: 1,
      at: 0,
      conversationId,
      event: { type: 'commands.changed', conversationId, commands },
    } as never)

  const host = document.createElement('div')
  document.body.append(host)
  const dispose = render(() => <BackgroundCommands />, host as unknown as HTMLElement)
  const sent: unknown[] = []
  const send = store.client.send
  store.client.send = (command) => sent.push(command)
  try {
    expect(host.querySelector('.followup-card')).toBeNull()
    expect(store.composerStackAbove()).toBe(false)

    snapshot('cv_bg', [{ id: 'cmd_1', command: 'npm run dev' }])
    snapshot('cv_other', [{ id: 'cmd_9', command: 'npm test' }])
    const rows = host.querySelectorAll('.followup-card')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain('npm run dev')
    expect(store.composerStackAbove()).toBe(true)

    click(rows[0]!.querySelector('button') as HTMLButtonElement)
    expect(sent).toEqual([{ type: 'command.stop', conversationId: 'cv_bg', id: 'cmd_1' }])
    // 行的去留只以服务端快照为准：停止之后由下一份快照移除。
    expect(host.querySelectorAll('.followup-card')).toHaveLength(1)
    snapshot('cv_bg', [])
    expect(host.querySelector('.followup-card')).toBeNull()
    expect(store.composerStackAbove()).toBe(false)
  } finally {
    store.client.send = send
    dispose()
  }
})
