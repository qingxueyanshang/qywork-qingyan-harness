/**
 * 覆盖范围：`square/SquareDialog.tsx`、`SquareGrid.tsx`、`SquareItem.tsx`、`MineList.tsx`、`actions.ts`、
 * `previews.tsx`、`SquareEntry.tsx`、`PublishDialog.tsx`（各类型的内容区、作品按名称搜索文件）
 * 与 `lib/store/square.ts`。本机服务的应答由测试给出（替换 `client.api`）。
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
let calls: string[] = []
/** 给出时 `/api/square/mine` 等它完成后才应答。 */
let mineGate: Promise<void> | null = null
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
  sq_work: {
    ...card('sq_work', 'work', '海边'),
    meta: { format: 'image', prompt: '写一首关于海的诗' },
    files: [{ path: 'image.png', hash: 'b'.repeat(64), size: 10, mime: 'image/png' }],
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
    if (path.startsWith('/api/files/find?')) {
      const p = new URLSearchParams(path.split('?')[1])
      // 空查询只返回浅层的临时文件，与服务端按目录逐层遍历、条数有上限时的结果相同。
      if (!p.get('q')) {
        return { matches: [{ path: '.tmp/a.png', kind: 'file' }], truncated: true } as T
      }
      const deck = '09_其他项目/01_千石有声/原稿/千石有声.pptx'
      const hit = p.get('office') === 'pptx' && deck.includes(p.get('q') ?? '')
      return { matches: hit ? [{ path: deck, kind: 'file' }] : [], truncated: false } as T
    }
    if (path === '/api/square/install') return { message: '已安装全局技能 发版流程' } as T
    if (path === '/api/plugins') {
      return { plugins: [{ id: 'weather', name: '天气', version: '1.0.0' }] } as T
    }
    if (path === '/api/square/mine') {
      if (mineGate) await mineGate
      return [
        {
          id: 'sq_mine',
          kind: 'work',
          title: '我的作品',
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
  mineGate = null
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

const navItem = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('.square-nav .nav-item')].find(
    (b) => b.textContent?.trim() === label,
  )!

/** 切换到该类型后按「发布」，返回打开的发布窗口。 */
async function openPublish(host: HTMLElement, label: string) {
  navItem(host, label).click()
  host.querySelector<HTMLButtonElement>('.square-publish-button')!.click()
  await until(() => host.querySelector('.square-publish-dialog') !== null)
  return host.querySelector<HTMLDialogElement>('.square-publish-dialog')!
}

function fill(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

/** 按名称取得发布窗口中的输入控件。 */
const control = (dialog: HTMLElement, label: string) =>
  dialog.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!

const submit = (dialog: HTMLElement) =>
  dialog
    .querySelector<HTMLFormElement>('.square-publish')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

test('类型中没有提示词；作品详情的「使用提示词」把提示词放入输入框并关闭弹窗', async () => {
  const { default: SquareDialog } = await import('./SquareDialog.tsx')
  squareStore.setSquareOpen(true)
  const view = await mount(() => <SquareDialog />)
  const labels = [...view.host.querySelectorAll('.square-nav .nav-item')].map((b) =>
    b.textContent?.trim(),
  )
  expect(labels).toEqual(['作品', '画布', '插件', '技能', 'MCP', '宠物', '皮肤', '发布记录'])
  await until(() => view.host.querySelector('.square-tile') !== null)
  view.host.querySelector<HTMLButtonElement>('.square-tile')!.click()
  await until(() => view.host.querySelector('.square-detail') !== null)
  view.button('使用提示词')!.click()
  await until(() => store.composerSeed() === '写一首关于海的诗')
  expect(squareStore.squareOpen()).toBe(false)
  view.close()
})

test('技能行上的「安装」不读取详情，结果显示在本行', async () => {
  const { default: SquareDialog } = await import('./SquareDialog.tsx')
  const view = await mount(() => <SquareDialog />)
  navItem(view.host, '技能').click()
  await until(() => view.host.querySelector('.square-row') !== null)
  view.button('安装')!.click()
  await until(
    () =>
      view.host.querySelector('.square-row .square-desc')?.textContent ===
      '已安装全局技能 发版流程',
  )
  expect(calls).toContain('POST /api/square/install')
  expect(calls).not.toContain('GET /api/square/items/sq_skill')
  view.close()
})

test('技能详情显示文件并可安装；标题行的返回回到列表', async () => {
  const { default: SquareDialog } = await import('./SquareDialog.tsx')
  const view = await mount(() => <SquareDialog />)
  navItem(view.host, '技能').click()
  await until(() => view.host.querySelector('.square-row-main') !== null)
  view.host.querySelector<HTMLButtonElement>('.square-row-main')!.click()
  await until(() => view.host.querySelector('.square-detail') !== null)
  expect(view.text()).toContain('按步骤发布版本')
  expect(view.text()).toContain('SKILL.md')
  view.button('安装')!.click()
  await until(() => view.text().includes('已安装全局技能 发版流程'))
  expect(calls).toContain('POST /api/square/install')
  view.host.querySelector<HTMLButtonElement>('[aria-label="返回"]')!.click()
  await until(() => view.host.querySelector('.square-row') !== null)
  expect(view.host.querySelector('.square-detail')).toBeNull()
  view.close()
})

test('打开发布记录时弹窗不被移出文档：读取期间保留上一项，完成后显示状态与驳回原因', async () => {
  const { Suspense } = await import('solid-js')
  const { default: SquareDialog } = await import('./SquareDialog.tsx')
  let release = () => {}
  mineGate = new Promise((resolve) => {
    release = resolve
  })
  // 与 `App.tsx` 相同，弹窗位于 Suspense 之内：其中的读取使它挂起时，整个弹窗被移出文档。
  const view = await mount(() => (
    <Suspense>
      <SquareDialog />
    </Suspense>
  ))
  await until(() => view.host.querySelector('.square-dialog') !== null)
  const dialog = view.host.querySelector('.square-dialog')
  navItem(view.host, '发布记录').click()
  await until(() => calls.includes('GET /api/square/mine'))
  for (let i = 0; i < 5; i++) {
    expect(view.host.querySelector('.square-dialog')).toBe(dialog)
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
  release()
  await until(() => view.text().includes('内容重复'))
  expect(view.host.querySelector('.square-dialog')).toBe(dialog)
  expect(view.text()).toContain('已驳回')
  view.close()
})

test('发布当前类型：皮肤的发布窗口没有选择列表，提交后转到发布记录', async () => {
  const { default: SquareDialog } = await import('./SquareDialog.tsx')
  const view = await mount(() => <SquareDialog />)
  const dialog = await openPublish(view.host, '皮肤')
  expect(dialog.open).toBe(true)
  expect(dialog.querySelector('.square-publish-title')?.textContent).toBe('发布皮肤')
  expect(dialog.querySelector('.square-choices, .square-thumbs')).toBeNull()
  expect(dialog.querySelector('.square-skin')).not.toBeNull()
  fill(control(dialog, '标题'), '夜色')
  submit(dialog)
  await until(() => view.host.querySelector('.square-publish-dialog') === null)
  expect(published).toMatchObject({ title: '夜色', source: { kind: 'skin' } })
  await until(() => view.text().includes('内容重复'))
  expect(navItem(view.host, '发布记录').classList.contains('active')).toBe(true)
  expect(view.host.querySelector('.square-publish-button')).toBeNull()
  view.close()
})

test('发布插件：从已安装的插件卡片中选择；缺少标题或内容时窗口内显示原因且不提交', async () => {
  const { default: SquareDialog } = await import('./SquareDialog.tsx')
  const view = await mount(() => <SquareDialog />)
  published = null
  const dialog = await openPublish(view.host, '插件')
  expect(dialog.querySelector('.square-publish-title')?.textContent).toBe('发布插件')
  expect(dialog.textContent).not.toContain('GitHub')
  submit(dialog)
  await until(() => dialog.querySelector('.square-publish-error')?.textContent === '请填写标题')
  fill(control(dialog, '标题'), '天气插件')
  submit(dialog)
  await until(() => dialog.querySelector('.square-publish-error')?.textContent === '请选择插件')
  expect(published).toBeNull()
  await until(() => dialog.querySelector('.square-choice') !== null)
  dialog.querySelector<HTMLButtonElement>('.square-choice')!.click()
  expect(dialog.querySelector('.square-choice')?.getAttribute('aria-selected')).toBe('true')
  submit(dialog)
  await until(() => published !== null)
  expect(published).toMatchObject({ title: '天气插件', source: { kind: 'plugin', id: 'weather' } })
  view.close()
})

test('作品按名称搜索文件：空查询列不到的深层文件可以搜到并发布', async () => {
  const { default: SquareDialog } = await import('./SquareDialog.tsx')
  const view = await mount(() => <SquareDialog />)
  const dialog = await openPublish(view.host, '作品')
  const rows = () => [...dialog.querySelectorAll<HTMLButtonElement>('.square-thumb')]
  await until(() => rows().some((r) => r.textContent?.includes('a.png')))
  expect(rows().some((r) => r.textContent?.includes('千石有声.pptx'))).toBe(false)
  fill(dialog.querySelector<HTMLInputElement>('input[type="search"]')!, '千石')
  const deck = '09_其他项目/01_千石有声/原稿/千石有声.pptx'
  await until(() => rows().some((r) => r.textContent?.includes('千石有声.pptx')))
  expect(calls.some((c) => c.includes('q=%E5%8D%83%E7%9F%B3') && c.includes('office=pptx'))).toBe(
    true,
  )
  rows()
    .find((r) => r.textContent?.includes('千石有声.pptx'))!
    .click()
  fill(control(dialog, '标题'), '千石有声')
  submit(dialog)
  await until(() => view.host.querySelector('.square-publish-dialog') === null)
  expect(published).toMatchObject({ title: '千石有声', source: { kind: 'work', path: deck } })
  view.close()
})
