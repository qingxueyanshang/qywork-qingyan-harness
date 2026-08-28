/**
 * 覆盖 `Transcript.tsx` 里正文块的重渲染判据。
 *
 * 锁的是一条真实失败形状：会话流每 push 一条（工具启动、用户消息、收尾读数），
 * **已经定稿的每一段正文**都重跑一遍 markdown 并整段替换 innerHTML。成因是
 * `streaming` 读的是全局量（忙闲 + 末项 id），而 effect 按依赖有没有通知重跑、
 * 不按取值有没有变化重跑。逐帧实测（真服务真前端，两轮四步）：一段 80 个节点的
 * 正文在定稿之后又被整段重建 9 次，其中 5 次挤在收尾那一毫秒里。
 *
 * 判据用节点身份：innerHTML 被重新赋值的话，原来那个子节点对象就不在了。
 * 流式转定稿那一次重渲染是应该的，所以基准取在它之后。
 *
 * DOM 在这里装、用完卸掉，动态 import 的理由同 `settings/LoadState.test.tsx`。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
  // happy-dom 没有 ResizeObserver，而会话流的贴底跟随挂在它上面。
  ;(globalThis as Record<string, unknown>).ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
  }
})
afterAll(async () => {
  await resetStore()
  await GlobalRegistrator.unregister()
})
/**
 * store 是模块级单例，`bun test` 一个进程跑全部文件——**这里改过的字段要还回去**，
 * 否则别的文件里「这一格应该是空的」那类断言会按文件顺序随机变红。
 */
async function resetStore() {
  const store = await import('../lib/store/index.ts')
  store.setState({
    activeConversation: null,
    busyConversations: [],
    views: {},
    todos: [],
    fileChanges: [],
    lastRunId: null,
  })
}

const CV = 'cv_prose'

describe('定稿的正文不跟着会话流的增长重建', () => {
  test('下一批工具一条条起来，那段正文的节点还是原来那个', async () => {
    const store = await import('../lib/store/index.ts')
    store.setState({
      activeConversation: CV,
      busyConversations: [CV],
      lastRunId: 'run_now',
      views: {
        [CV]: {
          runStartedAt: Date.now(),
          error: null,
          transcript: [
            { id: 'u1', kind: 'user', text: '问一句' },
            { id: 't1', kind: 'text', text: '# 标题\n\n一段正文。\n\n另一段正文。' },
          ],
        },
      },
    })

    const { render } = await import('solid-js/web')
    const { Transcript } = await import('./Transcript.tsx')
    const host = document.createElement('div')
    const dispose = render(() => <Transcript />, host as unknown as HTMLElement)

    const push = (id: string) =>
      store.applyEvent({
        seq: 1,
        at: 0,
        conversationId: CV,
        event: {
          type: 'tool.started',
          runId: 'run_now',
          stepId: id,
          toolName: 'read_file',
          action: { kind: 'read', objectLabel: '文件', target: 'a.ts' },
          args: {},
        },
      } as never)

    // 第一条把这段正文从流式转成定稿（末项不再是它）——那一次重渲染是应该的。
    push('s0')
    const prose = host.querySelector('.prose')
    const settled = prose?.firstElementChild
    expect(prose?.textContent).toContain('另一段正文')
    expect(settled).toBeTruthy()

    // 这一轮接着跑，会话流一条条长；这段正文一个字都没变。
    push('s1')
    push('s2')
    push('s3')

    expect(host.querySelector('.prose')).toBe(prose as never)
    expect(host.querySelector('.prose')?.firstElementChild).toBe(settled as never)

    dispose()
  })

  test('模型在 usage 前报错，收尾条仍显示命中 N/A', async () => {
    const store = await import('../lib/store/index.ts')
    store.setState({
      activeConversation: CV,
      busyConversations: [],
      lastRunId: 'run_failed',
      views: {
        [CV]: {
          runStartedAt: null,
          error: null,
          transcript: [
            { id: 'u-failed', kind: 'user', text: '开始' },
            {
              id: 'run-run_failed',
              kind: 'run',
              text: '',
              run: {
                runId: 'run_failed',
                stopReason: 'provider_error',
                usage: null,
                startedAt: 1_000,
                endedAt: 1_500,
                errorMessage: '模型连接失败',
              },
            },
          ],
        },
      },
    } as never)

    const { render } = await import('solid-js/web')
    const { Transcript } = await import('./Transcript.tsx')
    const host = document.createElement('div')
    const dispose = render(() => <Transcript />, host as unknown as HTMLElement)

    expect(host.textContent).toContain('命中 N/A')
    expect(host.textContent).toContain('模型连接失败')

    dispose()
  })
})
