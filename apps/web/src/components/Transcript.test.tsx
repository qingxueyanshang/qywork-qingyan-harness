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
    fileVersion: 0,
    fileChanges: [],
    lastRunId: null,
  })
}

describe('工具图片回放', () => {
  test('从历史 step 的 outcome 直接恢复图片，且不要求展开工具卡', async () => {
    const store = await import('../lib/store/index.ts')
    store.setState({
      activeConversation: CV,
      busyConversations: [],
      views: {
        [CV]: {
          history: { loading: null, nextCursor: null, error: null },
          runStartedAt: null,
          error: null,
          todos: [],
          transcript: [
            {
              id: 'tool-image-history',
              kind: 'tool',
              text: '',
              toolName: 'read_file',
              action: { kind: 'read', objectLabel: '文件', target: 'art/result.png' },
              args: { path: 'art/result.png' },
              status: 'success',
              outcome: {
                status: 'success',
                executed: true,
                message: '读取 art/result.png（图片）',
                data: { images: [{ data: 'aGVsbG8=', mime: 'image/png' }] },
              },
            },
          ],
        },
      },
    } as never)

    const { render } = await import('solid-js/web')
    const { Transcript } = await import('./Transcript.tsx')
    const host = document.createElement('div')
    document.body.append(host)
    const dispose = render(() => <Transcript />, host as unknown as HTMLElement)

    try {
      const image = host.querySelector<HTMLImageElement>('.tool-images img')
      expect(image).not.toBeNull()
      expect(image?.src).toBe('data:image/png;base64,aGVsbG8=')
      expect((host.querySelector('details') as HTMLDetailsElement | null)?.open).toBe(false)
    } finally {
      dispose()
      host.remove()
    }
  })
})

describe('编排画布', () => {
  test('四个并行节点使用可收缩等宽列，画布不再套横向滚动容器', async () => {
    const { render } = await import('solid-js/web')
    const { TranscriptRows } = await import('./Transcript.tsx')
    const host = document.createElement('div')
    const dispose = render(
      () => (
        <TranscriptRows
          items={
            [
              {
                id: 'wf-four',
                kind: 'tool',
                text: '',
                toolName: 'workflow',
                action: { kind: 'run', objectLabel: '编排', target: '四个候选' },
                args: {
                  goal: '四个候选',
                  nodes: [
                    { id: 'a', agent: 'glm' },
                    { id: 'b', agent: 'qwen' },
                    { id: 'c', agent: 'deepseek' },
                    { id: 'd', agent: 'gemini' },
                  ],
                },
                status: 'running',
              },
            ] as never
          }
        />
      ),
      host as unknown as HTMLElement,
    )

    try {
      const layers = host.querySelectorAll<HTMLElement>('.wf-layer')
      expect(layers).toHaveLength(3)
      expect(layers[1]?.style.gridTemplateColumns).toBe('repeat(4, minmax(0, 1fr))')
      expect(layers[1]?.style.maxWidth).toBe('676px')
      expect(host.querySelector('.wf-viewport')).toBeNull()
      expect(layers[1]?.querySelector('.wf-node-name')?.classList.contains('truncate')).toBe(false)
    } finally {
      dispose()
    }
  })

  test('共享入口的共线区间只生成一份路径', async () => {
    const { mergeWorkflowEdgeSegments } = await import('./Transcript.tsx')
    const paths = mergeWorkflowEdgeSegments([
      { axis: 'vertical', fixed: 100.5, from: 20.5, to: 40.5, live: false },
      { axis: 'vertical', fixed: 100.5, from: 20.5, to: 40.5, live: false },
      { axis: 'horizontal', fixed: 40.5, from: 20.5, to: 100.5, live: false },
      { axis: 'horizontal', fixed: 40.5, from: 60.5, to: 100.5, live: false },
      { axis: 'horizontal', fixed: 40.5, from: 100.5, to: 180.5, live: false },
    ])

    expect(paths).toEqual([
      { d: 'M100.5 20.5V40.5', live: false },
      { d: 'M20.5 40.5H180.5', live: false },
    ])
  })

  test('活动依赖与静态依赖共线时切成不重叠区间', async () => {
    const { mergeWorkflowEdgeSegments } = await import('./Transcript.tsx')
    const paths = mergeWorkflowEdgeSegments([
      { axis: 'horizontal', fixed: 40.5, from: 20.5, to: 100.5, live: false },
      { axis: 'horizontal', fixed: 40.5, from: 60.5, to: 100.5, live: true },
    ])

    expect(paths).toEqual([
      { d: 'M20.5 40.5H60.5', live: false },
      { d: 'M60.5 40.5H100.5', live: true },
    ])
  })
})

const CV = 'cv_prose'

describe('定稿的正文不跟着会话流的增长重建', () => {
  test('用户长消息按真实高度收敛，并可在右下角展开和收起', async () => {
    const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return this.textContent && this.textContent.length > 100 ? 240 : 20
      },
    })

    const store = await import('../lib/store/index.ts')
    store.setState({
      activeConversation: CV,
      busyConversations: [],
      views: {
        [CV]: {
          history: { loading: null, nextCursor: null, error: null },
          runStartedAt: null,
          error: null,
          todos: [],
          transcript: [
            { id: 'u-short', kind: 'user', text: '短消息' },
            { id: 'u-long', kind: 'user', text: '这是一条需要收敛的长消息。'.repeat(12) },
          ],
        },
      },
    })

    const { render } = await import('solid-js/web')
    const { Transcript } = await import('./Transcript.tsx')
    const host = document.createElement('div')
    document.body.append(host)
    const dispose = render(() => <Transcript />, host as unknown as HTMLElement)

    try {
      const bubbles = host.querySelectorAll('.bubble')
      expect(bubbles).toHaveLength(2)
      expect(bubbles[0]?.classList.contains('collapsible')).toBe(false)

      const longBubble = bubbles[1] as HTMLElement
      const toggle = longBubble.querySelector('.user-bubble-toggle') as HTMLButtonElement
      expect(longBubble.classList.contains('collapsible')).toBe(true)
      expect(toggle.textContent).toContain('展开全部')
      expect(toggle.getAttribute('aria-expanded')).toBe('false')

      toggle.click()
      await Promise.resolve()
      expect(longBubble.classList.contains('expanded')).toBe(true)
      expect(toggle.textContent).toContain('收起')
      expect(toggle.getAttribute('aria-expanded')).toBe('true')

      toggle.click()
      await Promise.resolve()
      expect(longBubble.classList.contains('expanded')).toBe(false)
      expect(toggle.textContent).toContain('展开全部')
    } finally {
      dispose()
      host.remove()
      if (height) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', height)
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight')
    }
  })

  test('折叠正文首次展开时才挂载', async () => {
    const store = await import('../lib/store/index.ts')
    store.setState({
      activeConversation: CV,
      busyConversations: [],
      views: {
        [CV]: {
          history: { loading: null, nextCursor: null, error: null },
          runStartedAt: null,
          error: null,
          transcript: [
            {
              id: 'tool-lazy',
              kind: 'tool',
              text: '',
              toolName: 'run_command',
              action: { kind: 'run', objectLabel: '命令', target: 'echo ok' },
              args: { command: 'echo ok' },
              status: 'success',
              outcome: {
                status: 'success',
                executed: true,
                message: '命令执行完成',
                data: { stdout: '首次展开后才能看见的输出' },
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

    const details = host.querySelector('details') as HTMLDetailsElement
    expect(details).toBeTruthy()
    expect(host.querySelector('.fold-body')).toBeNull()
    expect(host.textContent).not.toContain('首次展开后才能看见的输出')

    details.open = true
    details.dispatchEvent(new Event('toggle'))

    expect(host.querySelector('.fold-body')).toBeTruthy()
    expect(host.textContent).toContain('首次展开后才能看见的输出')

    dispose()
  })

  test('下一批工具一条条起来，那段正文的节点还是原来那个', async () => {
    const store = await import('../lib/store/index.ts')
    store.setState({
      activeConversation: CV,
      busyConversations: [CV],
      lastRunId: 'run_now',
      views: {
        [CV]: {
          history: { loading: null, nextCursor: null, error: null },
          runStartedAt: Date.now(),
          error: null,
          todos: [],
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
          history: { loading: null, nextCursor: null, error: null },
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

  test('正常完成不重复显示已完成', async () => {
    const store = await import('../lib/store/index.ts')
    store.setState({
      activeConversation: CV,
      busyConversations: [],
      lastRunId: 'run_done',
      views: {
        [CV]: {
          history: { loading: null, nextCursor: null, error: null },
          runStartedAt: null,
          error: null,
          transcript: [
            { id: 'u-done', kind: 'user', text: '开始' },
            {
              id: 'run-run_done',
              kind: 'run',
              text: '',
              run: {
                runId: 'run_done',
                stopReason: 'completed',
                usage: null,
                startedAt: 1_000,
                endedAt: 1_500,
                errorMessage: null,
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

    expect(host.querySelector('.run-reason')).toBeNull()

    dispose()
  })

  test('历史加载、失败重试和更早页入口都有可见反馈', async () => {
    const store = await import('../lib/store/index.ts')
    store.setState({
      activeConversation: CV,
      busyConversations: [],
      views: {
        [CV]: {
          history: { loading: 'initial', nextCursor: null, error: null },
          runStartedAt: null,
          error: null,
          todos: [],
          transcript: [],
        },
      },
    })

    const { render } = await import('solid-js/web')
    const { Transcript } = await import('./Transcript.tsx')
    const host = document.createElement('div')
    const dispose = render(() => <Transcript />, host as unknown as HTMLElement)

    expect(host.textContent).toContain('正在加载会话')
    store.setState('views', CV, 'history', {
      loading: null,
      nextCursor: null,
      error: { phase: 'initial', message: '网络断开' },
    })
    expect(host.textContent).toContain('历史记录加载失败：网络断开')
    expect(host.querySelector('.history-error button')?.textContent).toContain('重试')

    store.setState('views', CV, 'history', {
      loading: null,
      nextCursor: 'ms_old',
      error: null,
    })
    expect(host.querySelector('.history-button')?.textContent).toContain('加载更早记录')

    dispose()
  })
})
