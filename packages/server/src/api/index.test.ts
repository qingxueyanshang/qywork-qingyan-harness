/**
 * 派发器的契约。
 *
 * 拆成一域一文件之后，「哪条路径归谁管」从一个 439 行函数里的顺序，变成了
 * 八个模块各自的 `return null`。这里锁住那条契约本身：
 * **`null` 只表示「不归我管」**，任何真实结果都必须是 `Response`。
 *
 * 一个域返回了 `null` 但其实已经做过副作用，是这套结构唯一会出的新错——
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
import {
  createConversation,
  getConversation,
  getWorkspace,
  listConversations,
  listWorkspaces,
  Store,
  setConversationTitle,
  upsertWorkspace,
} from '@qywork/store'
import { type ApiDeps, handleApi } from './index.ts'

function deps(root = 'C:/ws/demo'): ApiDeps & { wsId: string } {
  let lan = false
  const store = new Store({ path: ':memory:' })
  const ws = upsertWorkspace(store, root, root.split(/[/]/).filter(Boolean).pop() ?? root)
  return {
    store,
    wsId: ws.id,
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
    })
  })

  test('根目录这种取不出目录名时回落到整条路径，不回空串', async () => {
    const res = await call('/api/workspace', undefined, deps('/'))
    expect(((await res?.json()) as { name: string }).name).toBe('/')
  })

  /* 指了一个不存在的项目要 404，**不能静默回落到最近打开的那个**——
     回落等于在用户以为是 A 的地方读写 B。 */
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
    createConversation(d.store, { workspaceId: oldId as never, model: 'm' })
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
    createConversation(d.store, { workspaceId: oldId as never, model: 'm' })
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
    createConversation(d.store, { workspaceId: oldId as never, model: 'm' })
    createConversation(d.store, { workspaceId: oldId as never, model: 'm' })
    expect(listConversations(d.store, oldId as never)).toHaveLength(2)

    const res = await call(`/api/workspaces/${oldId}/archive`, { method: 'POST' }, d)
    expect(res?.status).toBe(200)
    expect(await res?.json()).toEqual({ archived: 2 })
    expect(listConversations(d.store, oldId as never)).toHaveLength(0)

    // 归档之后新建的一条照常出现——归档的是「当时那些」，不是这个项目本身
    createConversation(d.store, { workspaceId: oldId as never, model: 'm' })
    expect(listConversations(d.store, oldId as never)).toHaveLength(1)
  })

  test('归档不删数据：按 id 仍然读得回来', async () => {
    const { d, oldId } = twoWorkspaces()
    const c = createConversation(d.store, { workspaceId: oldId as never, model: 'm' })
    await call(`/api/workspaces/${oldId}/archive`, { method: 'POST' }, d)
    expect(getConversation(d.store, c.id)).not.toBeNull()
  })

  test('重复归档回 0 条 —— 「0 条」和「成功」在界面上要能分开', async () => {
    const { d, oldId } = twoWorkspaces()
    createConversation(d.store, { workspaceId: oldId as never, model: 'm' })
    await call(`/api/workspaces/${oldId}/archive`, { method: 'POST' }, d)
    const again = await call(`/api/workspaces/${oldId}/archive`, { method: 'POST' }, d)
    expect(await again?.json()).toEqual({ archived: 0 })
  })

  /**
   * 新建项目的两条入参。
   *
   * **`QYWORK_HOME` 必须指到临时目录**：只给 name 那条会真的 mkdir，
   * 不改的话测试会往开发者真实的 `~/.qywork/workspaces/` 里堆文件夹——
   * 这个仓库为「测试残留污染真实账本」已经付过一次代价。
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
      const { workspace } = (await res?.json()) as { workspace: { name: string; rootPath: string } }
      expect(workspace.name).toBe('青学研上')
      expect(workspace.rootPath).toBe(join(home, 'workspaces', '青学研上'))
      expect((await stat(workspace.rootPath)).isDirectory()).toBe(true)
    })

    test('重名不复用已有目录，加后缀 —— 那里可能是上一个同名项目的东西', async () => {
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
      // 建了一半再失败最难查，所以默认根下不该留下任何东西
      expect(await stat(join(home, 'workspaces')).catch(() => null)).toBe(null)
    })

    test('两个都不给回 422', async () => {
      expect((await post({}, deps()))?.status).toBe(422)
    })

    test('给的路径已在账本里 —— 复用那一行，移除过的会话跟着回来', async () => {
      const d = deps('C:/ws/demo')
      const id = (d as unknown as { wsId: string }).wsId
      createConversation(d.store, { workspaceId: id as never, model: 'm' })
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
    createConversation(d.store, { workspaceId: oldId as never, model: 'm' })
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

  test('id 不存在回 404 —— 静默成功会让界面以为删掉了，刷新又回来', async () => {
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
    createConversation(d.store, { workspaceId: oldId as never, model: 'm' })
    createConversation(d.store, { workspaceId: oldId as never, model: 'm' })
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
 * 它现在同时喂两处界面：输入区的模型选择器，和设置里「从内置库选」那个下拉。
 * 后者要靠 `vendors` 才能把端点和环境变量名填出来——`provider` 是**协议**，
 * 协议里没有端点，所以少了厂商这一维，「选个模型就配好」根本无从做起。
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

  const models = async (d: ApiDeps) =>
    ((await (await call('/api/models', undefined, d))!.json()) as any).models

  test('内置模型带厂商，未收录的是 null', async () => {
    const d = withConfig('openai_compatible', '中转站上的某个模型')
    const list = await models(d)
    expect(list.find((m: any) => m.id === 'claude-opus-5').vendor).toBe('anthropic')
    expect(list.find((m: any) => m.id === 'deepseek-v4-flash').vendor).toBe('deepseek')
    expect(list.find((m: any) => m.id === '中转站上的某个模型').vendor).toBeNull()
  })

  /**
   * `effortLevels` 决定界面显不显示思考强度那个 chip。照实报——Haiku 4.5 走的是
   * budget_tokens，没有 effort 档；报成五档就是一个选了没反应的控件。
   */
  test('effortLevels 照实报，没有档位的就是空数组', async () => {
    const list = await models(withConfig('anthropic', 'claude-opus-5'))
    expect(list.find((m: any) => m.id === 'claude-opus-5').effortLevels.length).toBeGreaterThan(0)
    expect(list.find((m: any) => m.id === 'claude-haiku-4-5').effortLevels).toEqual([])
    expect(list.find((m: any) => m.id === 'qwen3.7-max').effortLevels).toEqual([])
  })

  /**
   * **档位按这个模型实际会走的协议算。**
   *
   * 复现的是一个只在某些配置下才犯的形状：接口是「以 OpenAI 兼容协议经中转站调
   * Claude」，目录里 claude-opus-5 的原生条目声明五档 effort，但兼容协议根本不发
   * Anthropic 那套思考字段。按原生条目报出去，界面就会画一个选了没反应的控件。
   */
  test('中转站以兼容协议调 Claude 时不报 Anthropic 的档位', async () => {
    const native = await models(withConfig('anthropic', 'claude-opus-5'))
    expect(native.find((m: any) => m.id === 'claude-opus-5').effortLevels.length).toBe(5)

    const relay = await models(withConfig('openai_compatible', 'claude-opus-5'))
    const row = relay.find((m: any) => m.id === 'claude-opus-5')
    expect(row.provider).toBe('openai_compatible')
    expect(row.effortLevels).toEqual([])
  })

  /** DeepSeek 两条协议的档位不一样，报的必须是接口实际用的那条。 */
  test('DeepSeek 按接口协议报档位', async () => {
    const compat = await models(withConfig('openai_compatible', 'deepseek-v4-flash'))
    expect(compat.find((m: any) => m.id === 'deepseek-v4-flash').effortLevels).toEqual([
      'high',
      'max',
    ])

    const responses = await models(withConfig('openai_responses', 'deepseek-v4-flash'))
    expect(responses.find((m: any) => m.id === 'deepseek-v4-flash').effortLevels).toEqual([])
  })

  /**
   * **`qy probe --save` 实测出来的档位要覆盖内置目录。**
   *
   * 这条锁的是一条容易断的链：`buildAdapter`（`ai/src/factory.ts:68-78`）拿
   * capabilities 覆盖目录，所以**真正发出去的请求**用的是校准值；这一侧只要漏取
   * 同一个返回值里的 `capabilities`（只拿 `kind`），
   * **界面上能选哪几档就仍然按内置目录报**。
   *
   * 失败形状是「校准了但界面纹丝不动」：探测器写回的结论有生产者没消费者，
   * 而两处口径不一致的后果是用户选不到一个其实调得动的档位。
   */
  test('探测写回的档位覆盖内置目录', async () => {
    const d = deps()
    ;(d as { config: unknown }).config = {
      active: { provider: 'p', model: 'deepseek-v4-flash' },
      providers: {
        p: {
          kind: 'openai_compatible',
          models: {
            'deepseek-v4-flash': {
              capabilities: { thinking: 'reasoning_effort', effortLevels: ['low', 'medium'] },
            },
          },
        },
      },
    }
    const row = (await models(d)).find((m: any) => m.id === 'deepseek-v4-flash')
    // 内置目录写的是 high/max，实测覆盖成 low/medium。
    expect(row.effortLevels).toEqual(['low', 'medium'])
  })

  /**
   * 未收录的模型**探过就算数**。
   *
   * 别在这一支写死 `effortLevels: []`。「未收录 = 没测过它吃不吃 effort」只在探测
   * 之前成立——自建端点和中转站正是最需要探的地方，探完界面照样不给选的话，
   * `qy probe --save` 对它们完全无效。
   */
  test('未收录的模型探过之后也报档位', async () => {
    const d = deps()
    ;(d as { config: unknown }).config = {
      active: { provider: 'p', model: '中转站上的某个模型' },
      providers: {
        p: {
          kind: 'openai_compatible',
          models: {
            中转站上的某个模型: {
              capabilities: { thinking: 'reasoning_effort', effortLevels: ['high'] },
            },
            没探过的: {},
          },
        },
      },
    }
    const list = await models(d)
    expect(list.find((m: any) => m.id === '中转站上的某个模型').effortLevels).toEqual(['high'])
    // 没探过的仍然是空：不能把「没测」说成「不支持」，也不能反过来。
    expect(list.find((m: any) => m.id === '没探过的').effortLevels).toEqual([])
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
          kind: 'openai_compatible',
          models: { 'deepseek-v4-flash': { effort: 'max' }, 'deepseek-v4-pro': {} },
        },
      },
    }
    const list = await models(d)
    const flash = list.find((m: any) => m.id === 'deepseek-v4-flash')
    expect(flash.effort).toBe('max')
    expect(flash.effortLevels).toEqual(['high', 'max'])
    // 同接口的另一个模型没选过就是 null，不跟着变。
    expect(list.find((m: any) => m.id === 'deepseek-v4-pro').effort).toBeNull()
    // 没在配置里声明过的内置模型同样是 null。
    expect(list.find((m: any) => m.id === 'claude-opus-5').effort).toBeNull()
  })

  /** 内置目录不能被改小：少一家厂商，界面上那一整组模型就没了。 */
  test('内置库覆盖九家厂商', async () => {
    const d = withConfig('anthropic', 'claude-opus-5')
    const body = (await (await call('/api/models', undefined, d))!.json()) as any
    expect(body.vendors.map((v: any) => v.id).sort()).toEqual([
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
    for (const id of ['gpt-5.6-sol', 'gemini-3.1-pro', 'grok-4.5', 'kimi-k3', 'glm-5.2']) {
      expect(body.models.some((m: any) => m.id === id)).toBe(true)
    }
  })

  /**
   * 人民币标价的三家要带出币种。少了它，¥6 会被当成 $6 显示，差七倍——
   * 而这个错误在界面上完全看不出来，它只是一个数字。
   */
  test('人民币标价的模型带币种', async () => {
    const d = withConfig('anthropic', 'claude-opus-5')
    const body = (await (await call('/api/models', undefined, d))!.json()) as any
    expect(body.models.find((m: any) => m.id === 'qwen3.7-max').currency).toBe('CNY')
    expect(body.models.find((m: any) => m.id === 'kimi-k3').currency).toBe('CNY')
    expect(body.models.find((m: any) => m.id === 'gpt-5.6-sol').currency).toBe('USD')
  })

  test('未收录的模型不假装支持 effort', async () => {
    const list = await models(withConfig('openai_compatible', '自建的'))
    expect(list.find((m: any) => m.id === '自建的').effortLevels).toEqual([])
  })

  /** 厂商表要带出端点与环境变量名，否则设置页只能继续让用户手填。 */
  test('厂商表带默认端点与环境变量名', async () => {
    const d = withConfig('anthropic', 'claude-opus-5')
    const body = (await (await call('/api/models', undefined, d))!.json()) as any
    const ds = body.vendors.find((v: any) => v.id === 'deepseek')
    expect(ds.defaultBaseUrl).toBe('https://api.deepseek.com/v1')
    expect(ds.apiKeyEnv).toBe('DEEPSEEK_API_KEY')
    expect(ds.defaultKind).toBe('openai_compatible')
    // Anthropic 走 SDK 自带默认，不编一个端点出来。
    expect(body.vendors.find((v: any) => v.id === 'anthropic').defaultBaseUrl).toBeUndefined()
  })

  test('每个内置厂商都至少有一个模型能挂上去', async () => {
    const d = withConfig('anthropic', 'claude-opus-5')
    const body = (await (await call('/api/models', undefined, d))!.json()) as any
    for (const v of body.vendors) {
      expect(body.models.some((m: any) => m.vendor === v.id)).toBe(true)
    }
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
    expect(await res?.json()).toEqual({ id: a.id, root: 'C:/ws/a', name: 'a' })
    const fallback = await call('/api/workspace', undefined, d)
    expect(((await fallback?.json()) as { id: string }).id).toBe(b.id)
  })

  test('加项目：不是本机已存在的目录就 422，并且不落盘', async () => {
    const { d } = twoProjects()
    const res = await call(
      '/api/workspaces',
      {
        method: 'POST',
        body: JSON.stringify({ path: 'C:/ws/根本没有这个目录' }),
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
    const d = { store } as unknown as ApiDeps
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
  })
})

/*
 * 工具清单下发什么。
 *
 * 锁的是「设置页拿不拿得到底层名与参数」——`ToolSpec` 上的东西被丢在服务端时，
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
    // 它不是常驻工具，用途里必须带上这条边界，否则这一页在说谎
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
describe('会话的重命名 / 归档 / 删除', () => {
  const conv = (d: ApiDeps & { wsId: string }) =>
    createConversation(d.store, { workspaceId: d.wsId as never, model: 'm' })

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

  /* 空名字在侧栏里会被兜底成「新对话」，用户会以为改名没生效。
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
