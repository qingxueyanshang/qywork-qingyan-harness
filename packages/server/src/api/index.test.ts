/**
 * 派发器的契约。
 *
 * 拆成一域一文件之后，「哪条路径归谁管」从一个 439 行函数里的顺序，变成了
 * 八个模块各自的 `return null`。这里锁住那条契约本身：
 * **`null` 只表示「不归本模块管」**，任何真实结果都必须是 `Response`。
 *
 * 一个域返回了 `null` 但已经做过副作用，是这套结构唯一会出的新错——
 * 那会让请求继续往下走，被后面的域或 404 接管，而副作用已经发生了。
 *
 * 夹具用 `as unknown as ApiDeps`：这里挑的三条路由只碰 `ApiDeps` 里的几个字段，
 * 为它们造一个真的 RunManager 只会把测试变成集成测试，
 * 而集成部分 `e2e.test.ts` 已经覆盖了。
 *
 * **Store 必须是真的**：派发器要按 `?ws=` 查 `workspaces` 表决定这一次请求
 * 问的是哪个项目——那张表就是「哪个根」的权威，假不了。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConversationHistoryPageResponse, MessageId } from '@qywork/core'
import {
  appendMessage,
  appendStep,
  createConversation,
  createRun,
  finishRun,
  getConversation,
  getWorkspace,
  getWorkspaceByPath,
  listConversations,
  listWorkspaces,
  openProviderRequest,
  Store,
  setConversationTitle,
  settleProviderRequest,
  upsertWorkspace,
} from '@qywork/store'
import type { ModelsResponse } from './conversations.ts'
import { type ApiDeps, handleApi } from './index.ts'

function deps(root = 'C:/ws/demo'): ApiDeps & { wsId: string } {
  let lan = false
  const store = new Store({ path: ':memory:' })
  const ws = upsertWorkspace(store, root, root.split(/[/]/).filter(Boolean).pop() ?? root)
  return {
    store,
    wsId: ws.id,
    config: {
      active: { provider: 'p', model: 'm' },
      providers: {
        p: { kind: 'openai_chat_completions', models: { m: {} } },
      },
      mode: 'auto',
    },
    // 会话那几条动作要用到这两个：删除前问一句「在跑吗」，重命名后广播一条。
    // 只给这两个方法，不造一个真的 RunManager / EventBus——那会把这里变成集成测试，
    // 而集成部分 `e2e.test.ts` 已经覆盖了。
    runs: { isBusy: () => false },
    bus: { publish: () => {} },
    enableLan: () => {
      lan = true
      return { port: 7788 }
    },
    disableLan: () => {
      lan = false
    },
    lanEnabled: () => lan,
    lanPort: () => 7788,
    // upsert 项目那条路会调它把分支监听指过去。真的监听在 `server.ts` 装配，
    // 这里只要不是 undefined。
    watchGit: () => {},
  } as unknown as ApiDeps & { wsId: string }
}

const call = (path: string, init?: RequestInit, d: ApiDeps = deps()) =>
  handleApi(new URL(`http://127.0.0.1${path}`), new Request(`http://127.0.0.1${path}`, init), d)

describe('派发', () => {
  test('没人认领的路径回 null，不是 404 —— 404 由调用方决定', async () => {
    expect(await call('/api/nope')).toBe(null)
    expect(await call('/api/plugins/x/y/z')).toBe(null)
  })

  test('认领了就回 Response', async () => {
    const res = await call('/api/workspace')
    expect(res).toBeInstanceOf(Response)
    expect(res?.status).toBe(200)
  })

  test('工作区那条回的是「这次问的是哪个项目」，名字取目录名', async () => {
    const d = deps()
    const res = await call('/api/workspace', undefined, d)
    expect(await res?.json()).toEqual({
      id: (d as unknown as { wsId: string }).wsId,
      root: 'C:/ws/demo',
      name: 'demo',
      // 这个目录不存在，读不到项目层配置，所以没有待决定的信任。
      pendingTrust: [],
    })
  })

  test('根目录这种取不出目录名时回落到整条路径，不回空串', async () => {
    const res = await call('/api/workspace', undefined, deps('/'))
    expect(((await res?.json()) as { name: string }).name).toBe('/')
  })

  /* 指了一个不存在的项目要 404，**不能静默回落到最近打开的那个**——
     回落等于在用户选定 A 的位置上读写 B。 */
  test('?ws= 指到不存在的项目回 404', async () => {
    const res = await call('/api/workspace?ws=ws_nope')
    expect(res?.status).toBe(404)
  })
})

describe('方法参与匹配，不是只看路径', () => {
  test('POST 才切局域网开关；GET 同一路径不归它管', async () => {
    const d = deps()
    expect(await call('/api/pairing/lan', undefined, d)).toBe(null)
    expect(d.lanEnabled()).toBe(false)
  })

  test('开关真的翻转，且回的是翻转后的状态', async () => {
    const d = deps()
    const on = await call(
      '/api/pairing/lan',
      { method: 'POST', body: JSON.stringify({ enabled: true }) },
      d,
    )
    expect(await on?.json()).toEqual({ enabled: true })
    expect(d.lanEnabled()).toBe(true)

    const off = await call(
      '/api/pairing/lan',
      { method: 'POST', body: JSON.stringify({ enabled: false }) },
      d,
    )
    expect(await off?.json()).toEqual({ enabled: false })
    expect(d.lanEnabled()).toBe(false)
  })

  test('body 不是合法 JSON 时按「关」处理，不抛 —— 开关默认落在更安全的一侧', async () => {
    const d = deps()
    const res = await call('/api/pairing/lan', { method: 'POST', body: 'not json' }, d)
    expect(res?.status).toBe(200)
  })
})

/**
 * 移除项目。
 *
 * 这一组盯的是三件会被写错的事：**会话真的跟着没了**（不是只删了项目行，
 * 留一批读不回来的孤儿）、**当前这个删不掉**（删了之后界面手里的 `?ws=`
 * 指向不存在的记录，随后每条请求都 404）、**不存在的 id 回 404 而不是静默成功**。
 */
describe('移除项目', () => {
  /** 两个项目：后 upsert 的那个是「当前」（不带 `?ws=` 落到最近打开的）。 */
  const twoWorkspaces = () => {
    const d = deps('C:/ws/old')
    const oldId = (d as unknown as { wsId: string }).wsId
    const current = upsertWorkspace(d.store, 'C:/ws/current', 'current')
    return { d, oldId, currentId: current.id }
  }

  test('移除项目只是从列表里拿掉，会话一条不少', async () => {
    const { d, oldId } = twoWorkspaces()
    createConversation(d.store, { workspaceId: oldId as never, provider: 'p', model: 'm' })
    expect(listConversations(d.store, oldId as never)).toHaveLength(1)

    const res = await call(`/api/workspaces/${oldId}`, { method: 'DELETE' }, d)
    expect(res?.status).toBe(200)
    expect(listWorkspaces(d.store).map((w) => String(w.id))).not.toContain(oldId)
    // 数据没动：行还在（`getWorkspace` 不过滤），会话照样读得回来
    expect(getWorkspace(d.store, oldId as never)).not.toBeNull()
    expect(listConversations(d.store, oldId as never)).toHaveLength(1)
  })

  test('重新添加同一路径 —— 项目和它的会话一起回来', async () => {
    const { d, oldId } = twoWorkspaces()
    createConversation(d.store, { workspaceId: oldId as never, provider: 'p', model: 'm' })
    expect((await call(`/api/workspaces/${oldId}`, { method: 'DELETE' }, d))?.status).toBe(200)

    const again = upsertWorkspace(d.store, 'C:/ws/old', 'old')
    expect(String(again.id)).toBe(oldId) // root_path UNIQUE，命中的是同一行
    expect(listWorkspaces(d.store).map((w) => String(w.id))).toContain(oldId)
    expect(listConversations(d.store, oldId as never)).toHaveLength(1)
  })

  test('移除两次 —— 第二次回 404，不静默当成功', async () => {
    const { d, oldId } = twoWorkspaces()
    expect((await call(`/api/workspaces/${oldId}`, { method: 'DELETE' }, d))?.status).toBe(200)
    expect((await call(`/api/workspaces/${oldId}`, { method: 'DELETE' }, d))?.status).toBe(404)
  })

  const patchPin = (id: string, pinned: boolean, d: ApiDeps) =>
    call(`/api/workspaces/${id}`, { method: 'PATCH', body: JSON.stringify({ pinned }) }, d)

  /* 侧栏顺序是「置顶 > 添加先后」，**不跟着切换重排**——按最近打开排的话
     切一次项目它就跳到最前，列表在用户眼皮底下来回跳，而置顶已经是显式按钮。 */
  test('置顶把项目提到最前，取消置顶回到添加时的位置', async () => {
    const { d, oldId, currentId } = twoWorkspaces()
    // old 先添加，所以默认排在前面；后添加的 current 在后
    expect(listWorkspaces(d.store).map((w) => String(w.id))).toEqual([oldId, currentId])

    expect((await patchPin(currentId, true, d))?.status).toBe(200)
    expect(listWorkspaces(d.store).map((w) => String(w.id))).toEqual([currentId, oldId])

    expect((await patchPin(currentId, false, d))?.status).toBe(200)
    expect(listWorkspaces(d.store).map((w) => String(w.id))).toEqual([oldId, currentId])
  })

  test('切项目不改变侧栏顺序 —— 顺序稳定，跳动才是 bug', async () => {
    const { d, oldId, currentId } = twoWorkspaces()
    const before = listWorkspaces(d.store).map((w) => String(w.id))
    // 「切过去」走的是同一条 upsert，它会更新 last_opened_at
    upsertWorkspace(d.store, 'C:/ws/current', 'current')
    expect(listWorkspaces(d.store).map((w) => String(w.id))).toEqual(before)
    expect(before).toEqual([oldId, currentId])
  })

  test('置顶两次回 404，body 不是布尔回 422 —— 都不静默当成功', async () => {
    const { d, oldId } = twoWorkspaces()
    expect((await patchPin(oldId, true, d))?.status).toBe(200)
    expect((await patchPin(oldId, true, d))?.status).toBe(404)
    const bad = await call(`/api/workspaces/${oldId}`, { method: 'PATCH', body: '{}' }, d)
    expect(bad?.status).toBe(422)
  })

  test('归档把现有会话从列表里拿掉，新建的照常显示', async () => {
    const { d, oldId } = twoWorkspaces()
    createConversation(d.store, { workspaceId: oldId as never, provider: 'p', model: 'm' })
    createConversation(d.store, { workspaceId: oldId as never, provider: 'p', model: 'm' })
    expect(listConversations(d.store, oldId as never)).toHaveLength(2)

    const res = await call(`/api/workspaces/${oldId}/archive`, { method: 'POST' }, d)
    expect(res?.status).toBe(200)
    expect(await res?.json()).toEqual({ archived: 2 })
    expect(listConversations(d.store, oldId as never)).toHaveLength(0)

    // 归档之后新建的一条照常出现——归档的是执行那一刻的那些，不是这个项目本身
    createConversation(d.store, { workspaceId: oldId as never, provider: 'p', model: 'm' })
    expect(listConversations(d.store, oldId as never)).toHaveLength(1)
  })

  test('归档不删数据：按 id 仍然读得回来', async () => {
    const { d, oldId } = twoWorkspaces()
    const c = createConversation(d.store, {
      workspaceId: oldId as never,
      provider: 'p',
      model: 'm',
    })
    await call(`/api/workspaces/${oldId}/archive`, { method: 'POST' }, d)
    expect(getConversation(d.store, c.id)).not.toBeNull()
  })

  test('重复归档回 0 条 —— 「0 条」和「成功」在界面上要能分开', async () => {
    const { d, oldId } = twoWorkspaces()
    createConversation(d.store, { workspaceId: oldId as never, provider: 'p', model: 'm' })
    await call(`/api/workspaces/${oldId}/archive`, { method: 'POST' }, d)
    const again = await call(`/api/workspaces/${oldId}/archive`, { method: 'POST' }, d)
    expect(await again?.json()).toEqual({ archived: 0 })
  })

  /**
   * 新建项目的两条入参。
   *
   * **`QYWORK_HOME` 必须指到临时目录**：只给 name 那条会真的 mkdir，
   * 不改的话测试会往开发者真实的 `~/.qywork/workspaces/` 里堆文件夹——
   * 「测试残留污染真实账本」在这个仓库里发生过。
   */
  describe('新建项目', () => {
    let home = ''
    const prev = process.env.QYWORK_HOME
    beforeEach(async () => {
      home = await mkdtemp(join(tmpdir(), 'qywork-newproj-'))
      process.env.QYWORK_HOME = home
    })
    afterEach(async () => {
      if (prev === undefined) delete process.env.QYWORK_HOME
      else process.env.QYWORK_HOME = prev
      await rm(home, { recursive: true, force: true }).catch(() => {})
    })

    const post = (body: unknown, d: ApiDeps) =>
      call('/api/workspaces', { method: 'POST', body: JSON.stringify(body) }, d)

    test('只给名字 —— 在默认根下建一个同名文件夹', async () => {
      const d = deps()
      const res = await post({ name: '青学研上' }, d)
      expect(res?.status).toBe(200)
      const { workspace, conversations } = (await res?.json()) as {
        workspace: { id: string; name: string; rootPath: string }
        conversations: { workspaceId: string; provider: string; model: string }[]
      }
      expect(workspace.name).toBe('青学研上')
      expect(workspace.rootPath).toBe(join(home, 'workspaces', '青学研上'))
      expect((await stat(workspace.rootPath)).isDirectory()).toBe(true)
      expect(conversations).toEqual([
        expect.objectContaining({ workspaceId: workspace.id, provider: 'p', model: 'm' }),
      ])
      expect(listConversations(d.store, workspace.id as never)).toHaveLength(1)
    })

    test('首会话写入失败时项目账本也回滚 —— 两次写入必须是同一个事务', async () => {
      const d = deps()
      d.store.db.exec(/* sql */ `
        CREATE TRIGGER reject_first_conversation
        BEFORE INSERT ON conversations
        BEGIN
          SELECT RAISE(ABORT, 'reject first conversation');
        END;
      `)

      await expect(post({ name: 'rollback' }, d)).rejects.toThrow('reject first conversation')
      expect(getWorkspaceByPath(d.store, join(home, 'workspaces', 'rollback'))).toBeNull()
    })

    test('重名不复用已有目录，加后缀 —— 那里可能是上一个同名项目的内容', async () => {
      const d = deps()
      const a = (await (await post({ name: 'demo' }, d))?.json()) as {
        workspace: { rootPath: string }
      }
      const b = (await (await post({ name: 'demo' }, d))?.json()) as {
        workspace: { rootPath: string }
      }
      expect(a.workspace.rootPath).toBe(join(home, 'workspaces', 'demo'))
      expect(b.workspace.rootPath).toBe(join(home, 'workspaces', 'demo-2'))
    })

    test('名字含分隔符或 .. 回 422 —— 拒绝而不是洗成别的名字', async () => {
      const d = deps()
      for (const name of ['../../etc', 'a/b', 'a\\b', '..', 'a:b', 'a?']) {
        expect((await post({ name }, d))?.status).toBe(422)
      }
      // 建了一半再失败最难查，所以默认根下不该留下任何文件
      expect(await stat(join(home, 'workspaces')).catch(() => null)).toBe(null)
    })

    test('两个都不给回 422', async () => {
      expect((await post({}, deps()))?.status).toBe(422)
    })

    test('给的路径已在账本里 —— 复用那一行，移除过的会话跟着回来', async () => {
      const d = deps('C:/ws/demo')
      const id = (d as unknown as { wsId: string }).wsId
      createConversation(d.store, { workspaceId: id as never, provider: 'p', model: 'm' })
      upsertWorkspace(d.store, 'C:/ws/other', 'other') // 留一个，不然移除会被 409 挡住
      expect((await call(`/api/workspaces/${id}`, { method: 'DELETE' }, d))?.status).toBe(200)
      expect(listWorkspaces(d.store).map((w) => String(w.id))).not.toContain(id)

      // 用真实存在的目录重新添加：路径唯一，命中的还是同一行
      const dir = await mkdtemp(join(tmpdir(), 'qywork-readd-'))
      const again = upsertWorkspace(d.store, dir, 'x')
      expect(String(again.id)).not.toBe(id) // 换了路径就是另一个项目
      await rm(dir, { recursive: true, force: true }).catch(() => {})

      const back = upsertWorkspace(d.store, 'C:/ws/demo', 'demo')
      expect(String(back.id)).toBe(id)
      expect(listConversations(d.store, id as never)).toHaveLength(1)
    })
  })

  test('列表里的会话数与列表口径一致 —— 归档后一起归零', async () => {
    const { d, oldId } = twoWorkspaces()
    createConversation(d.store, { workspaceId: oldId as never, provider: 'p', model: 'm' })
    const list = async () =>
      (
        (await (await call('/api/workspaces', undefined, d))?.json()) as {
          workspaces: { id: string; conversations: number }[]
        }
      ).workspaces.find((w) => w.id === oldId)?.conversations
    expect(await list()).toBe(1)
    await call(`/api/workspaces/${oldId}/archive`, { method: 'POST' }, d)
    expect(await list()).toBe(0)
  })

  test('当前项目也能移除，并回「接下来切哪个」', async () => {
    const { d, oldId, currentId } = twoWorkspaces()
    const res = await call(`/api/workspaces/${currentId}`, { method: 'DELETE' }, d)
    expect(res?.status).toBe(200)
    // 不回 next 的话，客户端手里的 ?ws= 指着刚被移除的那个，随后每条请求都 404
    expect(await res?.json()).toEqual({ ok: true, next: { id: oldId, rootPath: 'C:/ws/old' } })
    expect(listWorkspaces(d.store).map((w) => String(w.id))).not.toContain(currentId)
  })

  test('最后一个项目移不掉，回 409 且账本不动 —— 移完没有项目可服务', async () => {
    const d = deps('C:/ws/only')
    const onlyId = (d as unknown as { wsId: string }).wsId
    const res = await call(`/api/workspaces/${onlyId}`, { method: 'DELETE' }, d)
    expect(res?.status).toBe(409)
    expect(listWorkspaces(d.store).map((w) => String(w.id))).toContain(onlyId)
  })

  test('id 不存在回 404 —— 静默成功时界面显示已删除，刷新又回来', async () => {
    const { d } = twoWorkspaces()
    const res = await call('/api/workspaces/ws_nope', { method: 'DELETE' }, d)
    expect(res?.status).toBe(404)
  })

  test('GET 同一路径不归它管 —— 方法参与匹配', async () => {
    const { d, oldId } = twoWorkspaces()
    expect(await call(`/api/workspaces/${oldId}`, undefined, d)).toBe(null)
    expect(listWorkspaces(d.store).map((w) => String(w.id))).toContain(oldId)
  })

  test('列表带上会话数 —— 界面要能在删之前说出代价', async () => {
    const { d, oldId } = twoWorkspaces()
    createConversation(d.store, { workspaceId: oldId as never, provider: 'p', model: 'm' })
    createConversation(d.store, { workspaceId: oldId as never, provider: 'p', model: 'm' })
    const res = await call('/api/workspaces', undefined, d)
    const { workspaces } = (await res?.json()) as {
      workspaces: { id: string; conversations: number }[]
    }
    expect(workspaces.find((w) => w.id === oldId)?.conversations).toBe(2)
  })
})

describe('出参形状', () => {
  test('一律 application/json 且带 charset —— 少了 charset 中文会被按 ASCII 读', async () => {
    const res = await call('/api/workspace')
    expect(res?.headers.get('content-type')).toBe('application/json; charset=utf-8')
  })
})

/**
 * 模型目录端点（`api/conversations.ts` 的 `/api/models` 分支）。
 *
 * 它同时供两处界面使用，而两处要的字段不一样：
 * - 输入区的选择器要 `providers` —— **配置里真有的接口 × 模型**，第一层是接口。
 * - 设置页要 `library` —— 内置库，用来决定「加哪个模型」。
 *
 * 两者不能合成一个扁平表：合了就等于把「有哪些模型」当成「当前能选哪些」，
 * 而选中一个没挂在任何接口下的模型，请求会按当前接口发出去。
 */
describe('模型目录', () => {
  /** 一个接口一个模型就够了：这一组测的是「协议怎么算」，不是接口表怎么组。 */
  const withConfig = (kind: string, model: string): ApiDeps => {
    const d = deps()
    ;(d as { config: unknown }).config = {
      active: { provider: 'p', model },
      providers: { p: { kind, models: { [model]: {} } } },
    }
    return d
  }

  // 接服务端那一份契约类型，不在这里另编一个形状——编出来的形状不会因为接口改字段而红。
  const body = async (d: ApiDeps) =>
    (await (await call('/api/models', undefined, d))!.json()) as ModelsResponse
  /** 摊平成一张表只是为了断言好写；界面拿到的是分好组的。 */
  const models = async (d: ApiDeps) => (await body(d)).providers.flatMap((p) => p.models)

  /**
   * **只列配置里有的**。
   *
   * 并入内置目录那版列的是「世上有哪些模型」：用户选一个没挂在任何接口下的，
   * 请求按当前接口发出去，端点、key、价目表全是另一家的，而且不报错。
   */
  test('只列接口下挂着的模型，不并入内置目录', async () => {
    const list = await models(withConfig('openai_chat_completions', 'deepseek-v4-flash'))
    expect(list.map((m) => m.id)).toEqual(['deepseek-v4-flash'])
  })

  /** 第一层是接口。名字是用户起的，界面按它分组——没有它就没法切接口。 */
  test('按接口分组，接口名原样带出', async () => {
    const d = deps()
    ;(d as { config: unknown }).config = {
      active: { provider: '官方', model: 'deepseek-v4-flash' },
      providers: {
        官方: { kind: 'openai_chat_completions', models: { 'deepseek-v4-flash': {} } },
        中转站: { kind: 'openai_chat_completions', models: { 'deepseek-v4-flash': {} } },
      },
    }
    const b = await body(d)
    expect(b.providers.map((p) => p.name)).toEqual(['官方', '中转站'])
    // 同一个模型 id 挂在两个接口下是常态，两条都要在，各归各的组。
    expect(b.providers.every((p) => p.models[0]?.id === 'deepseek-v4-flash')).toBe(true)
    expect(b.active).toEqual({ provider: '官方', model: 'deepseek-v4-flash' })
  })

  test('内置目录里有的用显示名，没有的用 id 本身', async () => {
    const d = deps()
    ;(d as { config: unknown }).config = {
      active: { provider: 'p', model: 'claude-opus-5' },
      providers: {
        p: { kind: 'anthropic_messages', models: { 'claude-opus-5': {}, 中转站上的某个模型: {} } },
      },
    }
    const list = await models(d)
    expect(list.find((m) => m.id === 'claude-opus-5')?.label).toBe('Claude Opus 5')
    expect(list.find((m) => m.id === '中转站上的某个模型')?.label).toBe('中转站上的某个模型')
    expect(list.find((m) => m.id === '中转站上的某个模型')?.known).toBe(false)
  })

  /**
   * `effortLevels` 决定界面显不显示思考强度那个 chip。照实报——Haiku 4.5 走的是
   * budget_tokens，没有 effort 档；报成五档就是一个选了没反应的控件。
   */
  test('effortLevels 照实报，没有档位的就是空数组', async () => {
    const d = deps()
    ;(d as { config: unknown }).config = {
      active: { provider: 'p', model: 'claude-opus-5' },
      providers: {
        p: { kind: 'anthropic_messages', models: { 'claude-opus-5': {}, 'claude-haiku-4-5': {} } },
      },
    }
    const list = await models(d)
    expect(list.find((m) => m.id === 'claude-opus-5')?.effortLevels.length).toBeGreaterThan(0)
    expect(list.find((m) => m.id === 'claude-haiku-4-5')?.effortLevels).toEqual([])
  })

  /**
   * **档位按这个接口的协议算。**
   *
   * 复现的是一个只在某些配置下才犯的形状：接口是「以 OpenAI 兼容协议经中转站调
   * Claude」，目录里 claude-opus-5 的原生条目声明五档 effort，但兼容协议不发
   * Anthropic 那套思考字段。按原生条目报出去，界面就会画一个选了没反应的控件。
   */
  test('中转站以兼容协议调 Claude 时不报 Anthropic 的档位', async () => {
    const native = await models(withConfig('anthropic_messages', 'claude-opus-5'))
    expect(native.find((m) => m.id === 'claude-opus-5')?.effortLevels.length).toBe(5)

    const relay = await models(withConfig('openai_chat_completions', 'claude-opus-5'))
    expect(relay.find((m) => m.id === 'claude-opus-5')?.effortLevels).toEqual([])
  })

  /** DeepSeek 两条协议的档位不一样，报的必须是接口实际用的那条。 */
  test('DeepSeek 按接口协议报档位', async () => {
    const compat = await models(withConfig('openai_chat_completions', 'deepseek-v4-flash'))
    expect(compat.find((m) => m.id === 'deepseek-v4-flash')?.effortLevels).toEqual([
      'low',
      'high',
      'max',
    ])

    const responses = await models(withConfig('openai_responses', 'deepseek-v4-flash'))
    expect(responses.find((m) => m.id === 'deepseek-v4-flash')?.effortLevels).toEqual([])
  })

  /** 人工维护的模型规格覆盖内置 seed；它不是某个中转站的探测结果。 */
  test('模型库里人工维护的档位覆盖内置目录', async () => {
    const d = deps()
    ;(d as { config: unknown }).config = {
      active: { provider: 'p', model: 'deepseek-v4-flash' },
      providers: {
        p: { kind: 'openai_chat_completions', models: { 'deepseek-v4-flash': {} } },
      },
      catalog: {
        'deepseek-v4-flash|openai_chat_completions': {
          thinking: 'reasoning_effort',
          effortLevels: ['low', 'medium'],
        },
      },
    }
    const row = (await models(d)).find((m) => m.id === 'deepseek-v4-flash')!
    // 内置目录写的是 high/max，人工规格覆盖成 low/medium。
    expect(row.effortLevels).toEqual(['low', 'medium'])
  })

  /**
   * 未收录模型可以由用户在模型库明确补录能力；端点探测本身不能发明官方档位。
   */
  test('未收录的模型人工补录后也报档位', async () => {
    const d = deps()
    ;(d as { config: unknown }).config = {
      active: { provider: 'p', model: '中转站上的某个模型' },
      providers: {
        p: {
          kind: 'openai_chat_completions',
          models: { 中转站上的某个模型: {}, 没补录的: {} },
        },
      },
      catalog: {
        '中转站上的某个模型|openai_chat_completions': {
          thinking: 'reasoning_effort',
          effortLevels: ['high'],
        },
      },
    }
    const list = await models(d)
    expect(list.find((m) => m.id === '中转站上的某个模型')?.effortLevels).toEqual(['high'])
    expect(list.find((m) => m.id === '没补录的')?.effortLevels).toEqual([])
  })

  /**
   * 端点校准必须按接口隔离。同一个官方模型挂在两个中转站上，其中一个拒绝
   * effort 不能把另一个也判死；反过来，某个端点接受字段也不能凭空增加官方档位。
   */
  test('同模型的端点传输校准互不污染', async () => {
    const d = deps()
    ;(d as { config: unknown }).config = {
      active: { provider: 'blocked', model: 'deepseek-v4-flash' },
      providers: {
        blocked: {
          kind: 'openai_chat_completions',
          models: {
            'deepseek-v4-flash': { effort: 'high', transport: { effort: false } },
          },
        },
        untouched: {
          kind: 'openai_chat_completions',
          models: { 'deepseek-v4-flash': { effort: 'high' } },
        },
      },
    }
    const response = await body(d)
    const blocked = response.providers.find((p) => p.name === 'blocked')!.models[0]!
    const untouched = response.providers.find((p) => p.name === 'untouched')!.models[0]!

    expect(blocked.effortLevels).toEqual([])
    expect(blocked.effort).toBeNull()
    expect(untouched.effortLevels).toEqual(['low', 'high', 'max'])
    expect(untouched.effort).toBe('high')
  })

  /**
   * 选定档随模型目录一起下发，**与该模型的 `effortLevels` 同源**。
   *
   * 不走握手：握手是连接级、只报一次，而档位是「接口 × 模型」的属性——报上来的
   * 那个值在用户切一次模型之后就不再成立。分两处取则必然出现「档位面是 A 模型的、
   * 选定值是 B 模型的」。
   */
  test('选定档随模型目录下发，各取各的', async () => {
    const d = deps()
    ;(d as { config: unknown }).config = {
      active: { provider: 'ds', model: 'deepseek-v4-flash' },
      providers: {
        ds: {
          kind: 'openai_chat_completions',
          models: { 'deepseek-v4-flash': { effort: 'max' }, 'deepseek-v4-pro': {} },
        },
      },
    }
    const list = await models(d)
    const flash = list.find((m) => m.id === 'deepseek-v4-flash')!
    expect(flash.effort).toBe('max')
    expect(flash.effortLevels).toEqual(['low', 'high', 'max'])
    // 同接口的另一个模型没选过就是 null，不跟着变。
    expect(list.find((m) => m.id === 'deepseek-v4-pro')?.effort).toBeNull()
  })

  /** 内置库不能被改小：少一家厂商，设置页上那一整组模型就没了。 */
  test('内置库覆盖九家厂商', async () => {
    const b = await body(withConfig('anthropic_messages', 'claude-opus-5'))
    expect(b.library.map((v) => v.id).sort()).toEqual([
      'alibaba',
      'anthropic',
      'deepseek',
      'google',
      'minimax',
      'moonshot',
      'openai',
      'xai',
      'zhipu',
    ])
    const all = b.library.flatMap((v) => v.models)
    for (const id of ['gpt-5.6-sol', 'gemini-3.1-pro-preview', 'grok-4.6', 'kimi-k3', 'glm-5.2']) {
      expect(all.some((m) => m.id === id)).toBe(true)
    }
  })

  /**
   * 人民币标价的三家要带出币种。少了它，¥6 会被当成 $6 显示，差七倍——
   * 而这个错误在界面上完全看不出来，它只是一个数字。
   */
  test('内置库带单价与币种', async () => {
    const all = (await body(withConfig('anthropic_messages', 'claude-opus-5'))).library.flatMap(
      (v) => v.models,
    )
    expect(all.find((m) => m.id === 'qwen3.7-max')?.currency).toBe('CNY')
    expect(all.find((m) => m.id === 'kimi-k3')?.currency).toBe('CNY')
    expect(all.find((m) => m.id === 'glm-5.2')?.currency).toBe('CNY')
    const sol = all.find((m) => m.id === 'gpt-5.6-sol')!
    expect(sol.currency).toBe('USD')
    expect(sol.input).toBe(4)
    expect(sol.output).toBe(20)
  })

  /**
   * 缓存两档也要下发。
   *
   * 少了它们，界面上只有输入/输出两个数，而缓存价决定的是长会话的实际账单
   * ——Anthropic 写入是 input 的 1.25 倍，DeepSeek 写入不收费，
   * 这个差别在只看输入/输出时完全看不见。
   */
  test('库里带缓存命中与写入两档', async () => {
    const all = (await body(withConfig('anthropic_messages', 'claude-opus-5'))).library.flatMap(
      (v) => v.models,
    )
    const opus = all.find((m) => m.id === 'claude-opus-5')!
    expect(opus.cacheRead).toBe(0.5)
    expect(opus.cacheWrite).toBe(6.25)
    // DeepSeek 的自动前缀缓存写入不收费，那是个真值不是缺值。
    expect(all.find((m) => m.id === 'deepseek-v4-flash')?.cacheWrite).toBe(0)
  })

  /**
   * **同一个模型在库里只出现一次。**
   *
   * 目录里同 id 多条是给 `lookupModel` 按协议查能力用的（DeepSeek 有兼容和
   * Responses 两条）。协议是接口的属性，摆进模型列表就是让用户在两条看起来
   * 一样的模型之间选，而他手里没有判据。
   */
  test('内置库里同一个 id 只出一条', async () => {
    const ds = (await body(withConfig('anthropic_messages', 'claude-opus-5'))).library.find(
      (v) => v.id === 'deepseek',
    )!
    expect(ds.models.map((m) => m.id)).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'deepseek-v4-flash-vision-exp',
    ])
  })

  test('未收录的模型不假装支持 effort', async () => {
    const list = await models(withConfig('openai_chat_completions', '自建的'))
    expect(list.find((m) => m.id === '自建的')?.effortLevels).toEqual([])
  })

  /**
   * **库里不带任何接口字段。**
   *
   * 端点和协议是接口的属性。摆进模型库，「改一条模型参数」就会连带改掉端点，
   * 而那是另一件事：加一个模型会让别的模型连不上。
   */
  test('库里没有端点、协议这类接口字段', async () => {
    const b = await body(withConfig('anthropic_messages', 'claude-opus-5'))
    const ds = b.library.find((v) => v.id === 'deepseek')!
    // 比的是**整份键集**，不是逐个点名某几个字段不存在：点名只挡得住想得到的那几个，
    // 键集连没想到的一起挡。（`LibraryVendor` 现在也从类型上禁掉了多余字段。）
    expect(Object.keys(ds).sort()).toEqual(['displayName', 'id', 'models'])
  })

  /** 模型库人工覆盖要生效；端点探测单独落在 provider.models[].transport。 */
  test('config.catalog 里的覆盖盖在内置值上', async () => {
    const d = withConfig('anthropic_messages', 'claude-opus-5')
    ;(d.config as { catalog?: unknown }).catalog = {
      'claude-opus-5|anthropic_messages': { input: 99, output: 199 },
    }
    const all = (await body(d)).library.flatMap((v) => v.models)
    expect(all.find((m) => m.id === 'claude-opus-5')?.input).toBe(99)
  })

  /**
   * 目录里没有的模型，用户自己加一条参数之后要出现在库里。
   *
   * 不出现的话，「未收录模型计价按 0 算、用量报 $0」就仍然没有出口——
   * 而那正是加这一层的理由。
   */
  test('用户自己加的模型进库，按 vendor 归组', async () => {
    const d = withConfig('anthropic_messages', 'claude-opus-5')
    ;(d.config as { catalog?: unknown }).catalog = {
      '中转站上的某个模型|openai_chat_completions': {
        vendor: 'deepseek',
        input: 1,
        output: 2,
        contextWindow: 65_536,
      },
    }
    const ds = (await body(d)).library.find((v) => v.id === 'deepseek')!
    const row = ds.models.find((m) => m.id === '中转站上的某个模型')!
    expect(row.contextWindow).toBe(65_536)
  })

  /** 没写 vendor 的归到「自定义」，不静默丢掉。 */
  test('没挂厂商的落到自定义那一组', async () => {
    const d = withConfig('anthropic_messages', 'claude-opus-5')
    ;(d.config as { catalog?: unknown }).catalog = { 自建的: { input: 1, output: 2 } }
    const custom = (await body(d)).library.find((v) => v.displayName === '自定义')!
    expect(custom.models.map((m) => m.id)).toEqual(['自建的'])
  })

  test('每个厂商都至少有一个模型', async () => {
    const b = await body(withConfig('anthropic_messages', 'claude-opus-5'))
    for (const v of b.library) expect(v.models.length).toBeGreaterThan(0)
  })
})

/*
 * 多项目：这一次请求问的是哪个项目。
 *
 * 回归的是「换项目要重启整个 sidecar」那条——根因是服务端把「哪个根」存成了
 * 进程级常量。删掉之后由 `?ws=` 逐请求解析，所以下面这三条就是新权威的契约。
 */
describe('按 ?ws= 解析项目', () => {
  function twoProjects() {
    const store = new Store({ path: ':memory:' })
    const a = upsertWorkspace(store, 'C:/ws/a', 'a')
    const b = upsertWorkspace(store, 'C:/ws/b', 'b')
    return { d: { store } as unknown as ApiDeps, a, b }
  }

  test('带 ?ws= 时问的就是那一个，不是最近打开的那个', async () => {
    const { d, a, b } = twoProjects()
    // b 是后 upsert 的，缺省会落到它身上——所以这条能证明参数真的起作用。
    const res = await call(`/api/workspace?ws=${a.id}`, undefined, d)
    expect(await res?.json()).toEqual({ id: a.id, root: 'C:/ws/a', name: 'a', pendingTrust: [] })
    const fallback = await call('/api/workspace', undefined, d)
    expect(((await fallback?.json()) as { id: string }).id).toBe(b.id)
  })

  test('加项目：不是本机已存在的目录就 422，并且不落盘', async () => {
    const { d } = twoProjects()
    const res = await call(
      '/api/workspaces',
      {
        method: 'POST',
        body: JSON.stringify({ path: 'C:/ws/不存在的目录' }),
      },
      d,
    )
    expect(res?.status).toBe(422)
    const list = (await (await call('/api/workspaces', undefined, d))!.json()) as {
      workspaces: unknown[]
    }
    expect(list.workspaces.length).toBe(2)
  })

  test('加项目：已经有了就只更新「最近打开」，不插第二行', async () => {
    const store = new Store({ path: ':memory:' })
    const here = process.cwd()
    const d = {
      store,
      config: {
        active: { provider: 'p', model: 'm' },
        providers: { p: { kind: 'openai_chat_completions', models: { m: {} } } },
        mode: 'auto',
      },
      watchGit: () => {},
    } as unknown as ApiDeps
    const first = await call(
      '/api/workspaces',
      {
        method: 'POST',
        body: JSON.stringify({ path: here }),
      },
      d,
    )
    const again = await call(
      '/api/workspaces',
      {
        method: 'POST',
        body: JSON.stringify({ path: here }),
      },
      d,
    )
    const id1 = ((await first?.json()) as { workspace: { id: string } }).workspace.id
    const id2 = ((await again?.json()) as { workspace: { id: string } }).workspace.id
    expect(id2).toBe(id1)
    const list = (await (await call('/api/workspaces', undefined, d))!.json()) as {
      workspaces: unknown[]
    }
    expect(list.workspaces.length).toBe(1)
    expect(listConversations(store, id1 as never)).toHaveLength(1)
  })
})

/*
 * 工具清单下发什么。
 *
 * 锁的是「设置页拿不拿得到底层工具名与参数」——`ToolSpec` 上的字段被丢在服务端时，
 * 前端写了也显示不出来，而那种缺失在界面上只表现为「少了一栏」，不报任何错。
 *
 * `QYWORK_HOME` 指到临时目录：插件与 MCP 是三层作用域的，不隔离的话这条测试
 * 会去连开发者本机全局装的那些 server。
 */
describe('工具清单', () => {
  interface Row {
    name: string
    category: string
    facet: string
    objectLabel: string
    summary: string
    actionKind: string
    permissionEffect: string
    params: { name: string; required: boolean }[]
    source: string
  }

  let home = ''
  const prev = process.env.QYWORK_HOME
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'qywork-tools-'))
    process.env.QYWORK_HOME = home
  })
  afterEach(async () => {
    if (prev === undefined) delete process.env.QYWORK_HOME
    else process.env.QYWORK_HOME = prev
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  const tools = async (): Promise<Row[]> => {
    const res = await call('/api/tools')
    return ((await res?.json()) as { tools: Row[] }).tools
  }

  test('每行带底层名、动作、权限与来源，不是只有中文用途', async () => {
    const row = (await tools()).find((t) => t.name === 'read_file')
    expect(row).toBeDefined()
    expect(row?.actionKind).toBe('read')
    expect(row?.permissionEffect).toBe('read')
    expect(row?.objectLabel).toBe('文件')
    expect(row?.source).toBe('builtin')
  })

  test('参数只报名字与必填，整份 schema 不下发', async () => {
    const row = (await tools()).find((t) => t.name === 'read_file')
    expect(row?.params).toEqual([
      { name: 'path', required: true },
      { name: 'offset', required: false },
      { name: 'limit', required: false },
    ])
    // 整份 schema 的体积由第三方 server 决定，不受控——一个键都不该漏出去
    expect(row).not.toHaveProperty('parameters')
    expect(row).not.toHaveProperty('description')
  })

  test('没有参数的工具报空数组，不是缺这个键', async () => {
    const row = (await tools()).find((t) => t.name === 'list_schedules')
    expect(row?.params).toEqual([])
  })

  test('load_tool 列得出来 —— 它不在 registerBuiltinTools 里，漏了这一页就少一行', async () => {
    const row = (await tools()).find((t) => t.name === 'load_tool')
    expect(row?.source).toBe('builtin')
    expect(row?.params).toEqual([{ name: 'names', required: true }])
    // 它不是常驻工具，用途里必须带上这条边界，否则这一页与实际不符
    expect(row?.summary).toContain('超过阈值')
  })

  test('只回 tools 一个键 —— mcpServers 没有任何消费者', async () => {
    const res = await call('/api/tools')
    expect(Object.keys((await res?.json()) as object)).toEqual(['tools'])
  })

  /**
   * 函数型字段**只允许 `write_todos` 的动作**这一个：它首建报「创建」、
   * 之后报「修改」，那是用户两次点名要的行为，页面上如实报「不固定」。
   * 再多一个就要先问「这一栏还答不答得了问题」——一页全是「不固定」等于没有这一栏。
   * 权限效果一个都不许是函数：那一栏是安全边界，不固定就是没说。
   */
  test('只有 write_todos 的动作是函数型，权限效果一个都不是', async () => {
    for (const row of await tools()) {
      expect(row.permissionEffect).not.toBe('不固定')
      expect(row.objectLabel).not.toBe('不固定')
      if (row.actionKind === '不固定') expect(row.name).toBe('write_todos')
    }
  })
})

/*
 * 会话行上的三个动作：重命名 / 归档 / 硬删。
 *
 * 三条都会改账本，所以每一条的**拒绝路径**也要锁住——静默成功的写接口，
 * 在界面上和「成功了但什么都没变」完全一样。
 */
describe('会话历史分页接口', () => {
  test('一条请求返回完整轮次并给出下一页游标', async () => {
    const d = deps()
    const workspaceId = (d as unknown as { wsId: string }).wsId
    const conv = createConversation(d.store, {
      workspaceId: workspaceId as never,
      provider: 'p',
      model: 'm',
    })
    const ids: MessageId[] = []
    for (let i = 1; i <= 2; i++) {
      const msg = appendMessage(d.store, {
        conversationId: conv.id,
        role: 'user',
        content: `问题 ${i}`,
      })
      ids.push(msg.id)
      const run = createRun(d.store, {
        conversationId: conv.id,
        workspaceId: workspaceId as never,
        model: 'm',
        clientRequestId: `history-${i}`,
        userMessageId: msg.id,
        messageIdUpperBound: msg.id,
        contextSnapshot: [],
      })
      appendStep(d.store, { runId: run.id, seq: 1, kind: 'text', content: `答案 ${i}` })
      finishRun(d.store, run.id, { status: 'done', stopReason: 'completed' })
    }

    const res = await call(`/api/conversations/${conv.id}/history?limit=1`, undefined, d)
    expect(res?.status).toBe(200)
    const page = (await res?.json()) as ConversationHistoryPageResponse
    expect(page.messages.map((m) => m.content)).toEqual(['问题 2'])
    expect(page.runs).toHaveLength(1)
    expect(page.steps.map((s) => s.content)).toEqual(['答案 2'])
    expect(page.nextCursor).toBe(ids[1]!)
  })

  test('非法页大小回 422，不静默改成别的数', async () => {
    const d = deps()
    const workspaceId = (d as unknown as { wsId: string }).wsId
    const conv = createConversation(d.store, {
      workspaceId: workspaceId as never,
      provider: 'p',
      model: 'm',
    })
    const res = await call(`/api/conversations/${conv.id}/history?limit=0`, undefined, d)
    expect(res?.status).toBe(422)
  })
})

describe('会话诊断导出接口', () => {
  test('只导出路径里的那条会话，并以附件 JSON 返回', async () => {
    const d = deps()
    const workspaceId = (d as unknown as { wsId: string }).wsId
    const conv = createConversation(d.store, {
      workspaceId: workspaceId as never,
      provider: 'p',
      model: 'm',
      title: '要排查的会话',
    })
    const message = appendMessage(d.store, {
      conversationId: conv.id,
      role: 'user',
      content: '为什么只调用工具',
    })
    const run = createRun(d.store, {
      conversationId: conv.id,
      workspaceId: workspaceId as never,
      model: 'm',
      clientRequestId: crypto.randomUUID(),
      userMessageId: message.id,
      messageIdUpperBound: message.id,
      contextSnapshot: [{ group: 'workspaceState', content: '分支 main' }],
    })
    appendStep(d.store, {
      runId: run.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'read_file',
      status: 'success',
      payload: {
        kind: 'tool_result',
        args: { path: 'calc.js' },
        outcome: { status: 'success', executed: true, message: '读取完成' },
      },
    })
    const child = createConversation(d.store, {
      workspaceId: workspaceId as never,
      provider: 'p',
      model: 'm',
      title: '子 Agent',
      source: 'workflow',
      sourceRef: 'researcher',
    })
    appendMessage(d.store, {
      conversationId: child.id,
      role: 'user',
      content: '子 Agent 的完整内容',
    })
    appendStep(d.store, {
      runId: run.id,
      seq: 2,
      kind: 'tool_action',
      toolName: 'delegate',
      status: 'success',
      payload: {
        kind: 'tool_result',
        args: { task: '调查' },
        outcome: { status: 'success', executed: true, message: '调查完成' },
        childConversationId: child.id,
      },
    })
    const request = openProviderRequest(d.store, {
      runId: run.id,
      turnIndex: 0,
      retryIndex: 0,
      model: 'm',
      measuredInputTokens: 80,
      sentCategories: {} as never,
      omittedCategories: {} as never,
      payloadHash: 'payload-hash',
    })
    settleProviderRequest(d.store, request.id, 'received', null, null, 'tool_calls')
    finishRun(d.store, run.id, { status: 'done', stopReason: 'completed' })

    const res = await call(`/api/conversations/${conv.id}/export`, undefined, d)
    expect(res?.status).toBe(200)
    expect(res?.headers.get('content-type')).toContain('application/json')
    expect(res?.headers.get('content-disposition')).toContain(`qywork-session-${conv.id}.json`)
    const payload = (await res?.json()) as {
      kind: string
      schemaVersion: number
      conversation: { id: string }
      messages: { content: string }[]
      runs: {
        contextSnapshot: { group: string; content: string }[]
        steps: { toolName: string }[]
        providerRequests: { finishReason: string }[]
      }[]
      conversationTree: {
        childConversations: { conversation: { id: string }; messages: { content: string }[] }[]
        links: { parentConversationId: string; childConversationId: string }[]
      }
    }
    expect(payload.kind).toBe('qywork.session-diagnostic')
    expect(payload.schemaVersion).toBe(5)
    expect(payload.conversation.id).toBe(conv.id)
    expect(payload.messages.map((m) => m.content)).toEqual(['为什么只调用工具'])
    expect(payload.runs[0]?.contextSnapshot).toEqual([
      { group: 'workspaceState', content: '分支 main' },
    ])
    expect(payload.runs[0]?.steps[0]?.toolName).toBe('read_file')
    expect(payload.runs[0]?.providerRequests[0]?.finishReason).toBe('tool_calls')
    expect(payload.conversationTree.childConversations).toMatchObject([
      {
        conversation: { id: child.id },
        messages: [{ content: '子 Agent 的完整内容' }],
      },
    ])
    expect(payload.conversationTree.links).toMatchObject([
      { parentConversationId: conv.id, childConversationId: child.id },
    ])
  })

  test('不存在的会话回 404，不生成空诊断包', async () => {
    const res = await call('/api/conversations/cv_nope/export')
    expect(res?.status).toBe(404)
  })
})

describe('会话的重命名 / 归档 / 删除', () => {
  const conv = (d: ApiDeps & { wsId: string }) =>
    createConversation(d.store, { workspaceId: d.wsId as never, provider: 'p', model: 'm' })

  test('PATCH 改标题，回的是改完那一行', async () => {
    const d = deps()
    const c = conv(d)
    const res = await call(
      `/api/conversations/${c.id}`,
      { method: 'PATCH', body: JSON.stringify({ title: '改过的名字' }) },
      d,
    )
    expect(res?.status).toBe(200)
    expect(getConversation(d.store, c.id)?.title).toBe('改过的名字')
  })

  /* 空名字在侧栏里会被兜底成「新对话」，界面上等同于改名没生效。
     所以回 422 且**不落盘**（校验先于落盘）。 */
  test('空标题回 422 且不落盘', async () => {
    const d = deps()
    const c = conv(d)
    setConversationTitle(d.store, c.id, '原来的名字')
    const res = await call(
      `/api/conversations/${c.id}`,
      { method: 'PATCH', body: JSON.stringify({ title: '   ' }) },
      d,
    )
    expect(res?.status).toBe(422)
    expect(getConversation(d.store, c.id)?.title).toBe('原来的名字')
  })

  test('改一条不存在的会话回 404', async () => {
    const res = await call('/api/conversations/cv_nope', {
      method: 'PATCH',
      body: JSON.stringify({ title: 'x' }),
    })
    expect(res?.status).toBe(404)
  })

  /* 归档只写标记：列表里没有了，按 id 仍然读得回。 */
  test('归档之后不进列表，数据还在', async () => {
    const d = deps()
    const c = conv(d)
    const res = await call(`/api/conversations/${c.id}/archive`, { method: 'POST' }, d)
    expect(res?.status).toBe(200)
    expect(listConversations(d.store, d.wsId as never).map((x) => x.id)).not.toContain(c.id)
    expect(getConversation(d.store, c.id)).not.toBeNull()
  })

  /* 硬删是真删——这条锁的就是「删了就不在了」，不是「从列表里消失」。 */
  test('DELETE 是硬删，账本里那一行没了', async () => {
    const d = deps()
    const c = conv(d)
    const res = await call(`/api/conversations/${c.id}`, { method: 'DELETE' }, d)
    expect(res?.status).toBe(200)
    expect(getConversation(d.store, c.id)).toBeNull()
  })

  /*
   * 正在跑的会话删不得：级联会把 run / step 删掉，而那一轮还在往里写。
   * 这是唯一一种会留下悬空引用的形状，所以必须是拒绝，不是「尽力而为」。
   */
  test('正在执行的会话回 409，且那一行还在', async () => {
    const d = deps()
    const c = conv(d)
    ;(d as { runs: unknown }).runs = { isBusy: () => true }
    const res = await call(`/api/conversations/${c.id}`, { method: 'DELETE' }, d)
    expect(res?.status).toBe(409)
    expect(getConversation(d.store, c.id)).not.toBeNull()
  })

  test('删一条不存在的会话回 404，不静默成功', async () => {
    const res = await call('/api/conversations/cv_nope', { method: 'DELETE' })
    expect(res?.status).toBe(404)
  })

  /* GET 同一条路径不归这几条管：方法参与匹配，否则「读」会命中「写」的分支。 */
  test('GET /api/conversations/:id 没人认领', async () => {
    const d = deps()
    const c = conv(d)
    expect(await call(`/api/conversations/${c.id}`, undefined, d)).toBe(null)
  })
})
