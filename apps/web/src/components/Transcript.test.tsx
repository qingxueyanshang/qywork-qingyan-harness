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

const resizeCallbacks = new Map<Element, ResizeObserverCallback>()

beforeAll(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
  // happy-dom 没有 ResizeObserver，而会话流的贴底跟随挂在它上面。
  ;(globalThis as Record<string, unknown>).ResizeObserver = class {
    private readonly targets: Element[] = []

    constructor(private readonly callback: ResizeObserverCallback) {}

    observe(target: Element): void {
      this.targets.push(target)
      resizeCallbacks.set(target, this.callback)
    }

    disconnect(): void {
      for (const target of this.targets) resizeCallbacks.delete(target)
    }
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

function resize(target: Element) {
  resizeCallbacks.get(target)?.([], {} as ResizeObserver)
}

describe('工具图片回放', () => {
  test('read_file 图片只给模型，不自动渲染成会话图片', async () => {
    const store = await import('../lib/store/index.ts')
    store.setState({
      activeConversation: CV,
      busyConversations: [],
      views: {
        [CV]: {
          history: { loading: null, nextCursor: null, error: null },
          runStartedAt: null,
          usage: null,
          lastEventAt: null,
          retry: null,
          error: null,
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
      expect(image).toBeNull()
      expect((host.querySelector('details') as HTMLDetailsElement | null)?.open).toBe(false)
    } finally {
      dispose()
      host.remove()
    }
  })

  test('只有 outcome 明确声明 inline 才恢复图片', async () => {
    const store = await import('../lib/store/index.ts')
    store.setState({
      activeConversation: CV,
      busyConversations: [],
      views: {
        [CV]: {
          history: { loading: null, nextCursor: null, error: null },
          runStartedAt: null,
          usage: null,
          lastEventAt: null,
          retry: null,
          error: null,
          transcript: [
            {
              id: 'tool-image-inline',
              kind: 'tool',
              text: '',
              toolName: 'generate_image',
              action: { kind: 'run', objectLabel: '图片', target: 'art/result.png' },
              args: { path: 'art/result.png' },
              status: 'success',
              outcome: {
                status: 'success',
                executed: true,
                message: '生成 art/result.png',
                data: { images: [{ data: 'aGVsbG8=', mime: 'image/png' }] },
                presentation: { images: 'inline' },
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

  test('排队节点明确说明是在等待并发槽位', async () => {
    const { render } = await import('solid-js/web')
    const { TranscriptRows } = await import('./Transcript.tsx')
    const host = document.createElement('div')
    const dispose = render(
      () => (
        <TranscriptRows
          items={
            [
              {
                id: 'wf-queued',
                kind: 'tool',
                text: '',
                toolName: 'workflow',
                args: {
                  goal: '并行执行',
                  nodes: [{ id: 'fifth', agent: 'gemini', task: '实现第五版' }],
                },
                status: 'running',
                nodes: [
                  {
                    nodeId: 'fifth',
                    agent: 'gemini',
                    label: 'Gemini 开发者',
                    phase: 'queued',
                  },
                ],
              },
            ] as never
          }
        />
      ),
      host as unknown as HTMLElement,
    )

    try {
      expect(host.querySelector('.wf-node.queued')?.textContent).toContain('等待并发槽位')
    } finally {
      dispose()
    }
  })
})

describe('子会话与主会话共用流式外壳', () => {
  test('权威忙态已到但 run.started 尚未回放时也立即显示运行条', async () => {
    const store = await import('../lib/store/index.ts')
    const apiBefore = store.client.api
    let finishLoad!: (value: unknown) => void
    ;(store.client as unknown as { api: (path: string) => Promise<unknown> }).api = () =>
      new Promise((resolve) => {
        finishLoad = resolve
      })

    store.openConversationTab('cv_child_starting', '子 agent')
    store.syncViews()
    store.setState({
      activeConversation: null,
      busyConversations: ['cv_child_starting'],
      connection: 'ready',
      views: {
        cv_child_starting: {
          transcript: [],
          history: { loading: null, nextCursor: null, error: null },
          runStartedAt: null,
          usage: null,
          lastEventAt: null,
          retry: null,
          error: null,
        },
      },
    } as never)

    const { render } = await import('solid-js/web')
    const { default: ConversationPanel } = await import('./ConversationPanel.tsx')
    const host = document.createElement('div')
    document.body.append(host)
    const dispose = render(
      () => <ConversationPanel id="conversation-cv_child_starting" />,
      host as unknown as HTMLElement,
    )

    try {
      expect(host.querySelector('.run-strip')).not.toBeNull()
      expect(host.querySelector('.run-galaxy')).not.toBeNull()
    } finally {
      finishLoad({ messages: [], steps: [], runs: [], todos: [], nextCursor: null })
      await Promise.resolve()
      dispose()
      host.remove()
      store.closePanelTab('conversation-cv_child_starting')
      store.syncViews()
      ;(store.client as unknown as { api: typeof apiBefore }).api = apiBefore
    }
  })

  test('不重复挂待办，并显示自己的运行条与贴底跟随', async () => {
    const store = await import('../lib/store/index.ts')
    const apiBefore = store.client.api
    ;(store.client as unknown as { api: (path: string) => Promise<unknown> }).api = async (
      path,
    ) => {
      if (!path.includes('/cv_child/history')) throw new Error(`未预期请求：${path}`)
      return {
        messages: [],
        steps: [],
        runs: [
          {
            id: 'rn_child',
            userMessageId: null,
            createdAt: 100,
            finishedAt: null,
            stopReason: null,
            status: 'running',
            usage: {
              inputTokens: 1200,
              outputTokens: 300,
              cachedTokens: 0,
              cacheWriteTokens: 0,
              reasoningTokens: 0,
              cost: 0,
              currency: 'USD',
              turns: [],
            },
            errorMessage: null,
          },
        ],
        todos: [{ id: 'todo_1', content: '实现赛车', status: 'in_progress' }],
        nextCursor: null,
      }
    }

    store.openConversationTab('cv_child', '子 agent')
    store.syncViews()
    store.setState({
      activeConversation: null,
      busyConversations: ['cv_child'],
      connection: 'ready',
      views: {
        cv_child: {
          transcript: [
            {
              id: 'st_todos',
              kind: 'tool',
              text: '',
              toolName: 'write_todos',
              action: { kind: 'write', objectLabel: '待办' },
              args: {
                todos: [{ id: 'todo_1', content: '实现赛车', status: 'in_progress' }],
              },
              status: 'success',
            },
          ],
          history: { loading: null, nextCursor: null, error: null },
          runStartedAt: 100,
          usage: null,
          lastEventAt: 100,
          retry: null,
          error: null,
        },
      },
    } as never)

    const { render } = await import('solid-js/web')
    const { default: ConversationPanel } = await import('./ConversationPanel.tsx')
    const host = document.createElement('div')
    document.body.append(host)
    const dispose = render(
      () => <ConversationPanel id="conversation-cv_child" />,
      host as unknown as HTMLElement,
    )

    try {
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(host.querySelector('.child-cv-todos')).toBeNull()
      expect(host.querySelector('.run-strip')).not.toBeNull()
      expect(host.querySelector('.run-galaxy')).not.toBeNull()

      const details = host.querySelector<HTMLDetailsElement>('details')!
      details.open = true
      details.dispatchEvent(new Event('toggle'))
      await Promise.resolve()
      expect(host.querySelector('.todo-list')).not.toBeNull()
      expect(host.querySelectorAll('.todo-list')).toHaveLength(1)

      const scroller = host.querySelector<HTMLElement>('.child-cv')!
      const inner = host.querySelector<HTMLElement>('.child-cv-inner')!
      expect(scroller.classList.contains('conversation-scroll')).toBe(true)
      expect(inner.classList.contains('conversation-stream-inner')).toBe(true)
      let height = 300
      Object.defineProperties(scroller, {
        scrollHeight: { configurable: true, get: () => height },
        clientHeight: { configurable: true, get: () => 100 },
      })
      resize(inner)
      expect(scroller.scrollTop).toBe(300)

      // 鼠标或键盘展开 details 后，浏览器会为焦点自行滚动；这不是用户上翻。
      details
        .querySelector('summary')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
      scroller.scrollTop = 120
      scroller.dispatchEvent(new Event('scroll'))
      height = 480
      resize(inner)
      expect(scroller.scrollTop).toBe(480)

      // 用户主动上翻后尊重阅读位置，后续增长不再强拽到底。
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 }))
      scroller.scrollTop = 40
      scroller.dispatchEvent(new Event('scroll'))
      height = 620
      resize(inner)
      expect(scroller.scrollTop).toBe(40)
    } finally {
      dispose()
      host.remove()
      store.closePanelTab('conversation-cv_child')
      store.syncViews()
      ;(store.client as unknown as { api: typeof apiBefore }).api = apiBefore
    }
  })

  test('旧进程漏报子忙态时，只按精确指向它的运行中父步骤恢复流式 UI', async () => {
    const store = await import('../lib/store/index.ts')
    const apiBefore = store.client.api
    ;(store.client as unknown as { api: (path: string) => Promise<unknown> }).api = async (
      path,
    ) => {
      if (!path.includes('/cv_child_legacy/history')) throw new Error(`未预期请求：${path}`)
      return { messages: [], steps: [], runs: [], todos: [], nextCursor: null }
    }

    store.openConversationTab('cv_child_legacy', '旧进程成员')
    store.syncViews()
    store.setState({
      activeConversation: 'cv_parent',
      busyConversations: ['cv_parent'],
      connection: 'ready',
      views: {
        cv_parent: {
          transcript: [
            {
              id: 'delegate-running',
              kind: 'tool',
              text: '',
              toolName: 'subagent',
              args: { agent: 'qwen-racer', task: '继续修复' },
              status: 'running',
              childConversationId: 'cv_child_legacy',
            },
          ],
          history: { loading: null, nextCursor: null, error: null },
          runStartedAt: 100,
          usage: null,
          lastEventAt: 100,
          retry: null,
          error: null,
        },
        cv_child_legacy: {
          transcript: [{ id: 'thinking-child', kind: 'thinking', text: '仍在处理最新内容' }],
          history: { loading: null, nextCursor: null, error: null },
          runStartedAt: null,
          usage: null,
          lastEventAt: null,
          retry: null,
          error: null,
        },
      },
    } as never)

    const { render } = await import('solid-js/web')
    const { default: ConversationPanel } = await import('./ConversationPanel.tsx')
    const host = document.createElement('div')
    document.body.append(host)
    const dispose = render(
      () => <ConversationPanel id="conversation-cv_child_legacy" />,
      host as unknown as HTMLElement,
    )

    try {
      await Promise.resolve()
      expect(host.querySelector('.run-strip')).not.toBeNull()
      expect(host.querySelector('.fold-label')?.textContent).toContain('思考中')

      // 父步骤一收尾，兼容桥立即撤掉；不能把结束后的子页钉在运行中。
      store.setState('views', 'cv_parent', 'transcript', 0, 'status', 'success')
      await Promise.resolve()
      expect(host.querySelector('.run-strip')).toBeNull()
      expect(host.querySelector('.fold-label')?.textContent).toContain('已思考')
    } finally {
      dispose()
      host.remove()
      store.closePanelTab('conversation-cv_child_legacy')
      store.syncViews()
      ;(store.client as unknown as { api: typeof apiBefore }).api = apiBefore
    }
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
          usage: null,
          lastEventAt: null,
          retry: null,
          error: null,
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

  test('运行中的思考首次展开即滚到内层最新内容', async () => {
    const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return this.classList.contains('fold-pre') ? 240 : 0
      },
    })

    const { render } = await import('solid-js/web')
    const { TranscriptRows } = await import('./Transcript.tsx')
    const host = document.createElement('div')
    const dispose = render(
      () => (
        <TranscriptRows
          items={[{ id: 'thinking-live', kind: 'thinking', text: '正在形成最新结论' }]}
          live={() => true}
        />
      ),
      host as unknown as HTMLElement,
    )

    try {
      const details = host.querySelector('details') as HTMLDetailsElement
      details.open = true
      details.dispatchEvent(new Event('toggle'))
      await Promise.resolve()

      const pre = host.querySelector('.fold-pre') as HTMLPreElement
      expect(pre).toBeTruthy()
      expect(pre.scrollTop).toBe(240)
    } finally {
      dispose()
      if (height) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', height)
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight')
    }
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
          usage: null,
          lastEventAt: null,
          retry: null,
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

  test('未知停止码不渲染成内部枚举', async () => {
    const store = await import('../lib/store/index.ts')
    store.setState({
      activeConversation: CV,
      busyConversations: [],
      lastRunId: 'run_unknown_stop',
      views: {
        [CV]: {
          history: { loading: null, nextCursor: null, error: null },
          runStartedAt: null,
          error: null,
          transcript: [
            { id: 'u-unknown', kind: 'user', text: '开始' },
            {
              id: 'run-run_unknown_stop',
              kind: 'run',
              text: '',
              run: {
                runId: 'run_unknown_stop',
                stopReason: 'future_internal_reason',
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
    expect(host.textContent).not.toContain('future_internal_reason')

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
          usage: null,
          lastEventAt: null,
          retry: null,
          error: null,
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
