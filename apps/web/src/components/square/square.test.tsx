/**
 * 覆盖范围：`square/SquareDialog.tsx`、`SquareGrid.tsx`、`SquareItem.tsx`、`previews.tsx`、`SquareEntry.tsx` 与
 * `lib/store/square.ts`。本机服务的应答由测试给出（替换 `client.api`）。
 */

import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { CloudState, SquareCard, SquareDetail } from '@qywork/core'
import type { JSX } from 'solid-js'

let store: typeof import('../../lib/store/index.ts')
let cloudStore: typeof import('../../lib/store/cloud.ts')
let squareStore: typeof import('../../lib/store/square.ts')
let originalApi: typeof import('../../lib/store/index.ts')['client']['api']
let originalRaw: typeof import('../../lib/store/index.ts')['client']['raw']
let published: Record<string, unknown> | null = null
let githubSent: Record<string, unknown> | null = null
let calls: string[] = []
let cloud: CloudState

const card = (id: string, kind: SquareCard['kind'], title: string): SquareCard => ({
  id,
  kind,
  title,
  summary: '',
  author: '用户 a1b2c3',
  cover: null,
  version: 1,
  updatedAt: '2026-11-27T00:00:00.000Z',
  source: 'upload',
  repo: null,
  license: null,
})

const DETAILS: Record<string, SquareDetail> = {
  sq_prompt: {
    ...card('sq_prompt', 'prompt', '写诗'),
    meta: { text: '写一首关于海的诗' },
    files: [],
    mine: false,
  },
  sq_skill: {
    ...card('sq_skill', 'skill', '发版流程'),
    summary: '按步骤发布版本',
    meta: { name: '发版流程', description: '发布一个版本' },
    files: [{ path: 'SKILL.md', hash: 'a'.repeat(64), size: 10, mime: 'text/markdown' }],
    mine: false,
  },
}

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
  const { delegateEvents } = await import('solid-js/web')
  delegateEvents(['click', 'input', 'submit'])
  store = await import('../../lib/store/index.ts')
  cloudStore = await import('../../lib/store/cloud.ts')
  squareStore = await import('../../lib/store/square.ts')
  originalApi = store.client.api
  originalRaw = store.client.raw
  store.client.raw = async (path: string, init?: RequestInit): Promise<Response> => {
    calls.push(`${init?.method ?? 'GET'} ${path}`)
    if (path !== '/api/square/publish') throw new Error(`unexpected ${path}`)
    published = JSON.parse(String((init?.body as FormData).get('manifest')))
    return Response.json({ id: 'sq_new', version: 1, status: 'pending' })
  }
  store.client.api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
    calls.push(`${init?.method ?? 'GET'} ${path}`)
    if (path === '/api/cloud/state') return structuredClone(cloud) as T
    if (path.startsWith('/api/square/items?')) {
      const kind = new URLSearchParams(path.split('?')[1]).get('kind')
      const items = Object.values(DETAILS).filter((d) => d.kind === kind)
      return { items, next: null } as T
    }
    const item = /^\/api\/square\/items\/(.+)$/.exec(path)
    if (item) return structuredClone(DETAILS[decodeURIComponent(item[1]!)]) as T
    if (path === '/api/square/install') return { message: '已安装全局技能 发版流程' } as T
    if (path === '/api/square/github') {
      githubSent = JSON.parse(String(init?.body))
      return { id: 'sq_gh', version: 1, status: 'pending' } as T
    }
    if (path === '/api/square/mine') {
      return [
        {
          id: 'sq_mine',
          kind: 'prompt',
          title: '我的提示词',
          version: 2,
          status: 'rejected',
          note: '内容重复',
          listed: true,
          updatedAt: '2026-11-27T00:00:00.000Z',
          source: 'upload',
        },
      ] as T
    }
    throw new Error(`unexpected ${path}`)
  }
})

beforeEach(async () => {
  calls = []
  cloud = {
    state: 'signed_in',
    email: 'me@example.com',
    name: '',
    credits: 1,
    avatar: null,
    provider: 'qywork',
    origin: 'https://qywork.io',
    recharge: false,
    announcementSeen: null,
    support: false,
    supportUnread: 0,
    square: true,
  }
  await cloudStore.refreshCloudState()
  squareStore.setSquareOpen(false)
  store.setComposerSeed(null)
})

afterAll(async () => {
  store.client.api = originalApi
  store.client.raw = originalRaw
  await GlobalRegistrator.unregister()
})

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('等待超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function mount(view: () => JSX.Element) {
  const { render } = await import('solid-js/web')
  const host = document.createElement('div')
  document.body.append(host)
  const dispose = render(view, host)
  return {
    host,
    text: () => host.textContent ?? '',
    button: (label: string) =>
      [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label),
    close: () => {
      dispose()
      host.remove()
    },
  }
}

test('入口只在已登录且云端开通创作广场时出现', async () => {
  const { SquareEntry } = await import('./SquareEntry.tsx')
  const view = await mount(() => (
    <ul>
      <SquareEntry />
    </ul>
  ))
  expect(view.button('创作广场')).toBeDefined()
  cloud = { ...(cloud as Extract<CloudState, { state: 'signed_in' }>), square: false }
  await cloudStore.refreshCloudState()
  expect(view.button('创作广场')).toBeUndefined()
  view.close()
})

test('按类型列出条目；提示词「使用」把正文放入输入框并关闭弹窗', async () => {
  const { default: SquareDialog } = await import('./SquareDialog.tsx')
  squareStore.setSquareOpen(true)
  const view = await mount(() => <SquareDialog />)
  await until(() => calls.some((c) => c.includes('kind=work')))
  view.button('提示词')!.click()
  await until(() => view.text().includes('写诗'))
  ;[...view.host.querySelectorAll<HTMLButtonElement>('.square-card')][0]!.click()
  await until(() => view.text().includes('写一首关于海的诗'))
  view.button('使用')!.click()
  expect(store.composerSeed()).toBe('写一首关于海的诗')
  expect(squareStore.squareOpen()).toBe(false)
  view.close()
})

test('技能「安装」调用安装接口并显示结果；返回后回到列表', async () => {
  const { default: SquareDialog } = await import('./SquareDialog.tsx')
  const view = await mount(() => <SquareDialog />)
  view.button('技能')!.click()
  await until(() => view.text().includes('发版流程'))
  ;[...view.host.querySelectorAll<HTMLButtonElement>('.square-card')][0]!.click()
  await until(() => view.text().includes('按步骤发布版本'))
  expect(view.text()).toContain('SKILL.md')
  view.button('安装')!.click()
  await until(() => view.text().includes('已安装全局技能 发版流程'))
  expect(calls).toContain('POST /api/square/install')
  view.button('返回')!.click()
  await until(() => view.host.querySelector('.square-card') !== null)
  view.close()
})

test('发布提示词：提交后转到发布记录并显示结果；发布记录列出状态与驳回原因', async () => {
  const { default: SquareDialog } = await import('./SquareDialog.tsx')
  const view = await mount(() => <SquareDialog />)
  view.button('发布')!.click()
  await until(() => view.host.querySelector('.square-publish') !== null)
  const title = view.host.querySelector<HTMLInputElement>('.square-publish input')!
  title.value = '海边的诗'
  title.dispatchEvent(new Event('input', { bubbles: true }))
  const body = [...view.host.querySelectorAll<HTMLTextAreaElement>('.square-publish textarea')].at(
    -1,
  )!
  body.value = '写一首关于海的诗'
  body.dispatchEvent(new Event('input', { bubbles: true }))
  view.host
    .querySelector<HTMLFormElement>('.square-publish')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await until(() => view.text().includes('已提交，待审核'))
  expect(published).toMatchObject({
    title: '海边的诗',
    source: { kind: 'prompt', text: '写一首关于海的诗' },
  })
  await until(() => view.text().includes('内容重复'))
  expect(view.text()).toContain('已驳回')
  view.close()
})

test('插件选择 GitHub 仓库为来源：提交仓库、标签与子目录', async () => {
  const { default: SquareDialog } = await import('./SquareDialog.tsx')
  const view = await mount(() => <SquareDialog />)
  view.button('发布')!.click()
  await until(() => view.host.querySelector('.square-publish') !== null)
  const selects = () => [...view.host.querySelectorAll<HTMLSelectElement>('.square-publish select')]
  const choose = (select: HTMLSelectElement, value: string) => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  }
  choose(selects()[0]!, 'plugin')
  await until(() => view.text().includes('来源'))
  choose(selects()[1]!, 'github')
  await until(() => view.text().includes('标签或分支'))
  const inputs = [...view.host.querySelectorAll<HTMLInputElement>('.square-publish input')]
  const fill = (i: number, value: string) => {
    inputs[i]!.value = value
    inputs[i]!.dispatchEvent(new Event('input', { bubbles: true }))
  }
  fill(0, '天气插件')
  fill(1, 'https://github.com/example/weather')
  fill(2, 'v1.0.0')
  fill(3, 'plugin')
  view.host
    .querySelector<HTMLFormElement>('.square-publish')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await until(() => view.text().includes('已提交，待审核'))
  expect(githubSent).toEqual({
    kind: 'plugin',
    url: 'https://github.com/example/weather',
    ref: 'v1.0.0',
    path: 'plugin',
    title: '天气插件',
    summary: '',
  })
  view.close()
})
