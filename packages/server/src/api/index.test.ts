/**
 * 派发器的契约。
 *
 * 路由按域拆分到各自的文件后，路径归属由各模块的 `return null` 决定。
 * 此处锁定该契约本身：`null` 只表示不由本模块处理，任何实际结果都必须是 `Response`。
 *
 * 某个域返回 `null` 但已产生副作用，是该结构特有的错误：
 * 请求会继续向下匹配，由后续的域或 404 处理，而副作用已经发生。
 *
 * 夹具使用 `as unknown as ApiDeps`：此处选取的路由只访问 `ApiDeps` 中的少数字段，
 * 为它们构造真实的 RunManager 会使测试变成集成测试，
 * 而集成部分已由 `e2e.test.ts` 覆盖。
 *
 * Store 必须是真实实例：派发器按 `?ws=` 查询 `workspaces` 表，确定本次请求
 * 所指的项目；该表是项目根目录的权威，不能用替身代替。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type {
  ConversationChangesPageResponse,
  ConversationHistoryPageResponse,
  ConversationRunsResponse,
  ConversationUsageResponse,
  MessageId,
  RunId,
} from '@qywork/core'
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
  markProviderRequestContent,
  markProviderRequestHeaders,
  markProviderRequestSent,
  openProviderRequest,
  recordProviderRequestDiagnostic,
  recordUsage,
  Store,
  setConversationTitle,
  settleProviderRequest,
  upsertWorkspace,
} from '@qywork/store'
import type { ModelsResponse } from './conversations.ts'
import { type ApiDeps, handleApi } from './index.ts'

/**
 * RunManager 的替身。`runId` 是可写字段：历史接口的运行中快照只查询
 * 当前运行中的轮次，测试按需设置一个真实 run 的 id。
 */
interface RunsStub {
  isBusy(): boolean
  runId: RunId | null
  currentRunId(): RunId | null
}

function deps(root = '/ws/demo'): ApiDeps & { wsId: string } {
  let lan = false
  const runsStub: RunsStub = {
    isBusy: () => false,
    runId: null,
    currentRunId: () => runsStub.runId,
  }
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
    // 会话的删除与重命名操作需要这两个对象：删除前查询是否运行中，重命名后广播一条事件。
    // 只提供这两个方法，不构造真实的 RunManager / EventBus：构造真实实例会使此处变成集成测试，
    // 而集成部分已由 `e2e.test.ts` 覆盖。
    runs: runsStub,
    bus: { publish: () => {}, currentSeq: 77 },
    // 删除会话时关闭该会话名下的内置浏览器页面。没有宿主时为空操作。
    closeBrowserPages: async () => {},
    enableLan: () => {
      lan = true
      return { port: 7788 }
    },
    disableLan: () => {
      lan = false
    },
    lanEnabled: () => lan,
    lanPort: () => 7788,
    // upsert 项目时调用它，将分支监听指向该项目。真实的监听在 `server.ts` 中装配，
    // 此处只需不为 undefined。
    watchGit: () => {},
  } as unknown as ApiDeps & { wsId: string }
}

const call = (path: string, init?: RequestInit, d: ApiDeps = deps()) =>
  handleApi(new URL(`http://127.0.0.1${path}`), new Request(`http://127.0.0.1${path}`, init), d)

describe('派发', () => {
  test('无模块处理的路径返回 null 而不是 404：404 由调用方决定', async () => {
    expect(await call('/api/nope')).toBe(null)
    expect(await call('/api/plugins/x/y/z')).toBe(null)
  })

  test('有模块处理时返回 Response', async () => {
    const res = await call('/api/workspace')
    expect(res).toBeInstanceOf(Response)
    expect(res?.status).toBe(200)
  })

  test('工作区接口返回本次请求所指的项目，名称取目录名', async () => {
    const d = deps()
    const res = await call('/api/workspace', undefined, d)
    expect(await res?.json()).toEqual({
      id: (d as unknown as { wsId: string }).wsId,
      // 账本中的根目录是规范化后的形式（`upsertWorkspace`），派发器原样使用。
      root: resolve('/ws/demo'),
      name: 'demo',
    })
  })

  test('根目录等无法取得目录名时回退到完整路径，不返回空字符串', async () => {
    const res = await call('/api/workspace', undefined, deps('/'))
    expect(((await res?.json()) as { name: string }).name).toBe(resolve('/'))
  })

  /* 指定不存在的项目必须返回 404，不能静默回退到最近打开的项目：
     回退会在用户选定项目 A 时读写项目 B。 */
  test('?ws= 指向不存在的项目时返回 404', async () => {
    const res = await call('/api/workspace?ws=ws_nope')
    expect(res?.status).toBe(404)
  })
})

describe('方法参与匹配，不只匹配路径', () => {
  test('只有 POST 切换局域网开关；同一路径的 GET 不由它处理', async () => {
    const d = deps()
    expect(await call('/api/pairing/lan', undefined, d)).toBe(null)
    expect(d.lanEnabled()).toBe(false)
  })

  test('开关实际切换，且返回切换后的状态', async () => {
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

  test('body 不是合法 JSON 时按关闭处理且不抛出异常：默认取更安全的状态', async () => {
    const d = deps()
    const res = await call('/api/pairing/lan', { method: 'POST', body: 'not json' }, d)
    expect(res?.status).toBe(200)
  })
})

/**
 * 移除项目。
 *
 * 本组锁定以下行为：移除只从列表中移除项目，会话数据保留，重新添加同一路径时一并恢复；
 * 当前项目可以移除，响应携带下一个项目；最后一个项目无法移除；
 * 不存在的 id 返回 404，而不是静默成功。
 */
describe('移除项目', () => {
  /** 两个项目：后 upsert 的项目为当前项目（不带 `?ws=` 时取最近打开的项目）。 */
  const twoWorkspaces = () => {
    const d = deps('/ws/old')
    const oldId = (d as unknown as { wsId: string }).wsId
    const current = upsertWorkspace(d.store, '/ws/current', 'current')
    return { d, oldId, currentId: current.id }
  }

  test('移除项目只从列表中移除，会话全部保留', async () => {
    const { d, oldId } = twoWorkspaces()
    createConversation(d.store, { workspaceId: oldId as never, provider: 'p', model: 'm' })
    expect(listConversations(d.store, oldId as never)).toHaveLength(1)

    const res = await call(`/api/workspaces/${oldId}`, { method: 'DELETE' }, d)
    expect(res?.status).toBe(200)
    expect(listWorkspaces(d.store).map((w) => String(w.id))).not.toContain(oldId)
    // 数据未改动：项目行仍存在（`getWorkspace` 不过滤），会话仍可读取
    expect(getWorkspace(d.store, oldId as never)).not.toBeNull()
    expect(listConversations(d.store, oldId as never)).toHaveLength(1)
  })

  test('重新添加同一路径时项目与其会话一并恢复', async () => {
    const { d, oldId } = twoWorkspaces()
    createConversation(d.store, { workspaceId: oldId as never, provider: 'p', model: 'm' })
    expect((await call(`/api/workspaces/${oldId}`, { method: 'DELETE' }, d))?.status).toBe(200)

    const again = upsertWorkspace(d.store, '/ws/old', 'old')
    expect(String(again.id)).toBe(oldId) // root_path 有 UNIQUE 约束，命中同一行
    expect(listWorkspaces(d.store).map((w) => String(w.id))).toContain(oldId)
    expect(listConversations(d.store, oldId as never)).toHaveLength(1)
  })

  test('重复移除时第二次返回 404，不静默视为成功', async () => {
    const { d, oldId } = twoWorkspaces()
    expect((await call(`/api/workspaces/${oldId}`, { method: 'DELETE' }, d))?.status).toBe(200)
    expect((await call(`/api/workspaces/${oldId}`, { method: 'DELETE' }, d))?.status).toBe(404)
  })

  const patchPin = (id: string, pinned: boolean, d: ApiDeps) =>
    call(`/api/workspaces/${id}`, { method: 'PATCH', body: JSON.stringify({ pinned }) }, d)

  /* 侧栏按「置顶 > 添加顺序」排序，切换项目不改变顺序：按最近打开排序时，
     每次切换都会把该项目移到最前，列表位置随之变化；置顶已有显式按钮。 */
  test('置顶将项目移到最前，取消置顶后恢复添加顺序中的位置', async () => {
    const { d, oldId, currentId } = twoWorkspaces()
    // old 先添加，默认排在 current 之前
    expect(listWorkspaces(d.store).map((w) => String(w.id))).toEqual([oldId, currentId])

    expect((await patchPin(currentId, true, d))?.status).toBe(200)
    expect(listWorkspaces(d.store).map((w) => String(w.id))).toEqual([currentId, oldId])

    expect((await patchPin(currentId, false, d))?.status).toBe(200)
    expect(listWorkspaces(d.store).map((w) => String(w.id))).toEqual([oldId, currentId])
  })

  test('切换项目不改变侧栏顺序', async () => {
    const { d, oldId, currentId } = twoWorkspaces()
    const before = listWorkspaces(d.store).map((w) => String(w.id))
    // 切换项目使用同一个 upsert，它会更新 last_opened_at
    upsertWorkspace(d.store, '/ws/current', 'current')
    expect(listWorkspaces(d.store).map((w) => String(w.id))).toEqual(before)
    expect(before).toEqual([oldId, currentId])
  })

  test('重复置顶返回 404，body 不是布尔值时返回 422，均不静默视为成功', async () => {
    const { d, oldId } = twoWorkspaces()
    expect((await patchPin(oldId, true, d))?.status).toBe(200)
    expect((await patchPin(oldId, true, d))?.status).toBe(404)
    const bad = await call(`/api/workspaces/${oldId}`, { method: 'PATCH', body: '{}' }, d)
    expect(bad?.status).toBe(422)
  })

  test('归档将现有会话移出列表，之后新建的会话照常显示', async () => {
    const { d, oldId } = twoWorkspaces()
    createConversation(d.store, { workspaceId: oldId as never, provider: 'p', model: 'm' })
    createConversation(d.store, { workspaceId: oldId as never, provider: 'p', model: 'm' })
    expect(listConversations(d.store, oldId as never)).toHaveLength(2)

    const res = await call(`/api/workspaces/${oldId}/archive`, { method: 'POST' }, d)
    expect(res?.status).toBe(200)
    expect(await res?.json()).toEqual({ archived: 2 })
    expect(listConversations(d.store, oldId as never)).toHaveLength(0)

    // 归档后新建的会话照常显示：归档作用于执行时已有的会话，而非项目本身
    createConversation(d.store, { workspaceId: oldId as never, provider: 'p', model: 'm' })
    expect(listConversations(d.store, oldId as never)).toHaveLength(1)
  })

  test('归档不删除数据：按 id 仍可读取', async () => {
    const { d, oldId } = twoWorkspaces()
    const c = createConversation(d.store, {
      workspaceId: oldId as never,
      provider: 'p',
      model: 'm',
    })
    await call(`/api/workspaces/${oldId}/archive`, { method: 'POST' }, d)
    expect(getConversation(d.store, c.id)).not.toBeNull()
  })

  test('重复归档返回 0 条，界面据此区分「0 条」与「成功」', async () => {
    const { d, oldId } = twoWorkspaces()
    createConversation(d.store, { workspaceId: oldId as never, provider: 'p', model: 'm' })
    await call(`/api/workspaces/${oldId}/archive`, { method: 'POST' }, d)
    const again = await call(`/api/workspaces/${oldId}/archive`, { method: 'POST' }, d)
    expect(await again?.json()).toEqual({ archived: 0 })
  })

  /**
   * 新建项目的两种入参：名称与路径。
   *
   * `QYWORK_HOME` 必须指向临时目录：只提供 name 时会实际创建目录，
   * 不重定向时测试会在开发者真实的 `~/.qywork/workspaces/` 中创建文件夹，
   * 测试残留会污染真实账本。
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

    test('只提供名称时在默认根目录下创建同名文件夹', async () => {
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

    test('首个会话写入失败时项目记录一并回滚：两次写入必须在同一个事务中', async () => {
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

    test('重名时不复用已有目录而是添加后缀：该目录可能存有之前同名项目的内容', async () => {
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

    test('名称含分隔符或 .. 时返回 422，拒绝而不是改写为其他名称', async () => {
      const d = deps()
      for (const name of ['../../etc', 'a/b', 'a\\b', '..', 'a:b', 'a?']) {
        expect((await post({ name }, d))?.status).toBe(422)
      }
      // 部分创建后失败最难排查，因此默认根目录下不应留下任何文件
      expect(await stat(join(home, 'workspaces')).catch(() => null)).toBe(null)
    })

    test('名称与路径均未提供时返回 422', async () => {
      expect((await post({}, deps()))?.status).toBe(422)
    })

    test('提供的路径已在账本中时复用该行，已移除项目的会话一并恢复', async () => {
      const d = deps('/ws/demo')
      const id = (d as unknown as { wsId: string }).wsId
      createConversation(d.store, { workspaceId: id as never, provider: 'p', model: 'm' })
      upsertWorkspace(d.store, '/ws/other', 'other') // 保留另一个项目，否则移除会被 409 拒绝
      expect((await call(`/api/workspaces/${id}`, { method: 'DELETE' }, d))?.status).toBe(200)
      expect(listWorkspaces(d.store).map((w) => String(w.id))).not.toContain(id)

      // 项目按路径唯一匹配：新路径对应新项目，原路径命中同一行
      const dir = await mkdtemp(join(tmpdir(), 'qywork-readd-'))
      const again = upsertWorkspace(d.store, dir, 'x')
      expect(String(again.id)).not.toBe(id) // 不同路径对应不同项目
      await rm(dir, { recursive: true, force: true }).catch(() => {})

      const back = upsertWorkspace(d.store, '/ws/demo', 'demo')
      expect(String(back.id)).toBe(id)
      expect(listConversations(d.store, id as never)).toHaveLength(1)
    })
  })

  test('列表中的会话数与会话列表口径一致，归档后同步归零', async () => {
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

  test('当前项目可以移除，响应返回下一个项目', async () => {
    const { d, oldId, currentId } = twoWorkspaces()
    const res = await call(`/api/workspaces/${currentId}`, { method: 'DELETE' }, d)
    expect(res?.status).toBe(200)
    // 不返回 next 时，客户端持有的 ?ws= 指向已移除的项目，后续请求均返回 404
    expect(await res?.json()).toEqual({
      ok: true,
      next: { id: oldId, rootPath: resolve('/ws/old') },
    })
    expect(listWorkspaces(d.store).map((w) => String(w.id))).not.toContain(currentId)
  })

  test('最后一个项目无法移除：返回 409 且账本不变，否则没有可服务的项目', async () => {
    const d = deps('/ws/only')
    const onlyId = (d as unknown as { wsId: string }).wsId
    const res = await call(`/api/workspaces/${onlyId}`, { method: 'DELETE' }, d)
    expect(res?.status).toBe(409)
    expect(listWorkspaces(d.store).map((w) => String(w.id))).toContain(onlyId)
  })

  test('id 不存在时返回 404：静默成功会使界面显示已删除，刷新后又出现', async () => {
    const { d } = twoWorkspaces()
    const res = await call('/api/workspaces/ws_nope', { method: 'DELETE' }, d)
    expect(res?.status).toBe(404)
  })

  test('同一路径的 GET 不由该路由处理：方法参与匹配', async () => {
    const { d, oldId } = twoWorkspaces()
    expect(await call(`/api/workspaces/${oldId}`, undefined, d)).toBe(null)
    expect(listWorkspaces(d.store).map((w) => String(w.id))).toContain(oldId)
  })

  test('列表附带会话数，界面在删除前据此提示影响范围', async () => {
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

describe('响应格式', () => {
  test('一律为 application/json 并带 charset：缺少 charset 时中文会按 ASCII 解析', async () => {
    const res = await call('/api/workspace')
    expect(res?.headers.get('content-type')).toBe('application/json; charset=utf-8')
  })
})

/**
 * 模型目录端点（`api/conversations.ts` 的 `/api/models` 分支）。
 *
 * 它同时供两处界面使用，两处所需的字段不同：
 * - 输入区的选择器使用 `providers`：配置中实际存在的接口 × 模型，第一层为接口。
 * - 设置页使用 `library`：内置库，用于选择要添加的模型。
 *
 * 两者不能合并为一张扁平表：合并会把「有哪些模型」当作「当前可选哪些」，
 * 而选中未配置在任何接口下的模型时，请求会按当前接口发出。
 */
describe('模型目录', () => {
  /** 一个接口、一个模型即可：本组测试档位按协议的计算，不测试接口表的组织。 */
  const withConfig = (kind: string, model: string): ApiDeps => {
    const d = deps()
    ;(d as { config: unknown }).config = {
      active: { provider: 'p', model },
      providers: { p: { kind, models: { [model]: {} } } },
    }
    return d
  }

  // 使用服务端的契约类型，不在此处另行定义：另行定义的类型不会因接口字段变更而报错。
  const body = async (d: ApiDeps) =>
    (await (await call('/api/models', undefined, d))!.json()) as ModelsResponse
  /** 展平为一张表仅为便于断言；界面取得的是分组后的结构。 */
  const models = async (d: ApiDeps) => (await body(d)).providers.flatMap((p) => p.models)

  test('生成接入方式由目录下发，不因自定义地址改变原生协议或添加其他厂商协议', async () => {
    const d = withConfig('openai_chat_completions', 'm')
    d.config.providers.p!.baseUrl = 'https://relay.example/v1'
    const catalog = (await body(d)).mediaLibrary
    expect(catalog.find((m) => m.id === 'wan3.0-video-prime')?.kinds).toEqual([
      'dashscope_videos',
      'openai_videos',
    ])
    expect(catalog.find((m) => m.id === 'grok-imagine-video-1.5')?.kinds).toEqual(['xai_videos'])
    expect(catalog.find((m) => m.id === 'doubao-seedance-2-5-260628')?.kinds).toEqual([
      'ark_videos',
      'openai_videos',
    ])
  })

  test('专享 SD2.5 将音频上限和原生时长选项同步到模型库与画布', async () => {
    const id = '专享sd2.5(30图10音/4-30秒/720p)'
    const d = withConfig('openai_chat_completions', 'm')
    d.config.providers.p!.media = { [id]: { kind: 'openai_videos' } }
    const response = await body(d)
    expect(response.mediaLibrary.find((m) => m.id === id)).toMatchObject({
      vendor: 'Mumugofe',
      kinds: ['openai_videos'],
      maxImages: 30,
      maxVideos: 0,
      maxAudios: 10,
    })
    const model = response.media.find((m) => m.id === id)!
    expect(model.operations).toEqual(['text_to_video', 'reference_to_video'])
    const seconds = model.params.find((p) => p.name === 'seconds')!
    expect(seconds.type).toBe('enum')
    expect(seconds.default).toBe('5')
    expect(seconds.values).toHaveLength(27)
    expect(seconds.values?.[0]).toBe('4')
    expect(seconds.values?.at(-1)).toBe('30')
    expect(seconds.valueLabels?.['4']).toBe('4秒')
    expect(model.params.find((p) => p.name === 'size')?.shapes).toEqual([
      { ratio: '16:9', tier: '720P', value: '1280x720' },
      { ratio: '9:16', tier: '720P', value: '720x1280' },
    ])
    expect(model.params.map((p) => p.name)).toEqual(['seconds', 'size'])
  })

  test('新编码模型只列出一行，保留订阅限制与未知单价', async () => {
    const response = await body(withConfig('openai_chat_completions', 'step-5-preview'))
    expect(response.providers[0]?.models[0]).toMatchObject({
      known: true,
      defaultBaseUrl: 'https://api.stepfun.com/v1',
      effortLevels: ['low', 'medium', 'high'],
    })
    expect(response.library.find((v) => v.id === 'stepfun')?.models.map((m) => m.id)).toEqual([
      'step-5-preview',
    ])
    const minimax = response.library.find((v) => v.id === 'minimax')!.models
    expect(minimax.map((m) => m.id)).toEqual(['MiniMax-M3.1-Flash-Preview', 'MiniMax-M3'])
    expect(minimax[0]).toMatchObject({
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
    })
    expect(minimax[0]?.priceNotes?.join('')).toContain('M Plan')
    expect(
      (await models(withConfig('anthropic_messages', 'step-5-preview')))[0]?.defaultBaseUrl,
    ).toBe('https://api.stepfun.com')
    expect(
      (await models(withConfig('openai_responses', 'MiniMax-M3.1-Flash-Preview')))[0],
    ).toMatchObject({ known: true, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] })
  })

  test('官方默认地址按模型与协议下发，显式端点不被写回覆盖', async () => {
    const d = withConfig('openai_chat_completions', 'deepseek-flash')
    d.config.providers.p!.baseUrl = 'https://relay.example/v1'
    expect((await models(d))[0]?.defaultBaseUrl).toBe('https://api.deepseek.com/v1')
    expect(d.config.providers.p!.baseUrl).toBe('https://relay.example/v1')
    expect(
      (await models(withConfig('anthropic_messages', 'deepseek-flash')))[0]?.defaultBaseUrl,
    ).toBe('https://api.deepseek.com/anthropic')
    expect(
      (await models(withConfig('openai_chat_completions', 'mimo-v2.6-pro')))[0]?.defaultBaseUrl,
    ).toBe('https://api.xiaomimimo.com/v1')
    expect(
      (await models(withConfig('openai_chat_completions', 'custom')))[0]?.defaultBaseUrl,
    ).toBeUndefined()
    d.config.catalog = { 'custom|openai_chat_completions': { vendor: 'deepseek' } }
    d.config.providers.p!.models.custom = {}
    expect((await models(d)).find((m) => m.id === 'custom')?.defaultBaseUrl).toBe(
      'https://api.deepseek.com/v1',
    )
  })

  /**
   * 只列出配置中存在的模型。
   *
   * 并入内置目录时列出的是全部已知模型：用户选中未配置在任何接口下的模型后，
   * 请求按当前接口发出，端点、key 与价目表均属于另一家厂商，且不报错。
   */
  test('只列出接口下配置的模型，不并入内置目录', async () => {
    const list = await models(withConfig('openai_chat_completions', 'deepseek-flash'))
    expect(list.map((m) => m.id)).toEqual(['deepseek-flash'])
  })

  /** 第一层为接口。接口名由用户命名，界面按它分组，缺少接口名时无法切换接口。 */
  test('按接口分组，接口名原样返回', async () => {
    const d = deps()
    ;(d as { config: unknown }).config = {
      active: { provider: '官方', model: 'deepseek-flash' },
      providers: {
        官方: { kind: 'openai_chat_completions', models: { 'deepseek-flash': {} } },
        中转站: { kind: 'openai_chat_completions', models: { 'deepseek-flash': {} } },
      },
    }
    const b = await body(d)
    expect(b.providers.map((p) => p.name)).toEqual(['官方', '中转站'])
    // 同一模型 id 配置在两个接口下是常见情况，两条都须保留，分别归入各自的分组。
    expect(b.providers.every((p) => p.models[0]?.id === 'deepseek-flash')).toBe(true)
    expect(b.active).toEqual({ provider: '官方', model: 'deepseek-flash' })
  })

  test('内置目录中收录的模型使用显示名，未收录的使用 id', async () => {
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
   * `effortLevels` 决定界面是否显示思考强度 chip，必须如实返回：Haiku 4.5 使用
   * budget_tokens，没有 effort 档位；返回五档会产生一个选择后不生效的控件。
   */
  test('effortLevels 如实返回，没有档位时为空数组', async () => {
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
   * 档位按该接口的协议计算。
   *
   * 该错误只在特定配置下出现：接口以 OpenAI 兼容协议经中转站调用
   * Claude，目录中 claude-opus-5 的原生条目声明五档 effort，但兼容协议不发送
   * Anthropic 的思考字段。按原生条目返回时，界面会渲染一个选择后不生效的控件。
   */
  test('中转站以兼容协议调用 Claude 时不返回 Anthropic 的档位', async () => {
    const native = await models(withConfig('anthropic_messages', 'claude-opus-5'))
    expect(native.find((m) => m.id === 'claude-opus-5')?.effortLevels.length).toBe(5)

    const relay = await models(withConfig('openai_chat_completions', 'claude-opus-5'))
    expect(relay.find((m) => m.id === 'claude-opus-5')?.effortLevels).toEqual([])
  })

  /** 各协议都按自身目录声明可用档位。 */
  test('DeepSeek 按接口协议返回档位', async () => {
    const compat = await models(withConfig('openai_chat_completions', 'deepseek-flash'))
    expect(compat.find((m) => m.id === 'deepseek-flash')?.effortLevels).toEqual([
      'low',
      'high',
      'max',
    ])

    const responses = await models(withConfig('openai_responses', 'deepseek-flash'))
    expect(responses.find((m) => m.id === 'deepseek-flash')?.effortLevels).toEqual([
      'low',
      'high',
      'max',
    ])
  })

  test('已保存的 DeepSeek 五档探测结果不覆盖内置三档，已失效的选择不回显', async () => {
    const d = withConfig('openai_chat_completions', 'deepseek-flash')
    const provider = Object.values(d.config.providers)[0]!
    provider.models['deepseek-flash'] = {
      effort: 'xhigh',
      transport: {
        effort: true,
        effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        thinking: 'deepseek_thinking',
      },
    }
    const response = await body(d)
    expect(response.providers[0]!.models[0]!.effortLevels).toEqual(['low', 'high', 'max'])
    expect(response.providers[0]!.models[0]!.effort).toBeNull()
    expect(
      response.library
        .find((v) => v.id === 'deepseek')!
        .models.find((m) => m.id === 'deepseek-flash')!.effortLevels,
    ).toEqual(['low', 'high', 'max'])
  })

  /** 人工维护的模型规格覆盖内置 seed；它不是某个中转站的探测结果。 */
  test('模型库里人工维护的档位覆盖内置目录', async () => {
    const d = deps()
    ;(d as { config: unknown }).config = {
      active: { provider: 'p', model: 'deepseek-flash' },
      providers: {
        p: { kind: 'openai_chat_completions', models: { 'deepseek-flash': {} } },
      },
      catalog: {
        'deepseek-flash|openai_chat_completions': {
          thinking: 'reasoning_effort',
          effortLevels: ['low', 'medium'],
        },
      },
    }
    const row = (await models(d)).find((m) => m.id === 'deepseek-flash')!
    // 内置目录为 high/max，人工规格覆盖为 low/medium。
    expect(row.effortLevels).toEqual(['low', 'medium'])
  })

  /**
   * 未收录模型可由用户在模型库中补录能力；端点探测不能生成官方档位。
   */
  test('未收录的模型经人工补录后返回档位', async () => {
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
   * 端点校准必须按接口隔离。同一官方模型配置在两个中转站上时，其中一个拒绝
   * effort 不应使另一个也判定为不支持；反之，某个端点接受该字段，也不能据此增加官方档位。
   */
  test('同一模型的端点传输校准互不影响', async () => {
    const d = deps()
    ;(d as { config: unknown }).config = {
      active: { provider: 'blocked', model: 'deepseek-flash' },
      providers: {
        blocked: {
          kind: 'openai_chat_completions',
          models: {
            'deepseek-flash': { effort: 'high', transport: { effort: false } },
          },
        },
        untouched: {
          kind: 'openai_chat_completions',
          models: { 'deepseek-flash': { effort: 'high' } },
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
   * 选定档位随模型目录一起下发，与该模型的 `effortLevels` 来源相同。
   *
   * 不经由握手下发：握手是连接级的，只发送一次，而档位是「接口 × 模型」的属性，
   * 用户切换模型后握手中的值即失效。分两处获取时，必然出现可选档位属于模型 A、
   * 选定值属于模型 B 的情况。
   */
  test('选定档位随模型目录下发，各模型独立取值', async () => {
    const d = deps()
    ;(d as { config: unknown }).config = {
      active: { provider: 'ds', model: 'deepseek-flash' },
      providers: {
        ds: {
          kind: 'openai_chat_completions',
          models: { 'deepseek-flash': { effort: 'max' }, 'deepseek-v4-pro': {} },
        },
      },
    }
    const list = await models(d)
    const flash = list.find((m) => m.id === 'deepseek-flash')!
    expect(flash.effort).toBe('max')
    expect(flash.effortLevels).toEqual(['low', 'high', 'max'])
    // 同一接口的另一个模型未选择过时为 null，不随之改变。
    expect(list.find((m) => m.id === 'deepseek-v4-pro')?.effort).toBeNull()
  })

  test('GPT-6 Astra 的规格同时进入模型库与已配置的模型列表', async () => {
    const b = await body(withConfig('openai_responses', 'gpt-6-astra'))
    const rows = b.library
      .find((v) => v.id === 'openai')!
      .models.filter((m) => m.id === 'gpt-6-astra')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      label: 'GPT-6 Astra',
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      vision: true,
      thinksByDefault: true,
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      input: 10,
      output: 50,
      cacheRead: 1,
      cacheWrite: 12.5,
      currency: 'USD',
    })
    expect(b.providers[0]!.models[0]).toMatchObject({
      id: 'gpt-6-astra',
      label: 'GPT-6 Astra',
      known: true,
      vision: true,
      video: false,
      effortLevels: rows[0]!.effortLevels,
    })
  })

  test('GPT-6.1 Sol 的规格与新缓存价格进入模型库和已配置列表', async () => {
    const b = await body(withConfig('openai_responses', 'gpt-6.1-sol'))
    const rows = b.library
      .find((v) => v.id === 'openai')!
      .models.filter((m) => m.id === 'gpt-6.1-sol')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      label: 'GPT-6.1 Sol',
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      vision: true,
      thinksByDefault: true,
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      input: 2,
      output: 10,
      cacheRead: 0.1,
      cacheWrite: 2.5,
      currency: 'USD',
    })
    expect(b.providers[0]!.models[0]).toMatchObject({
      id: 'gpt-6.1-sol',
      label: 'GPT-6.1 Sol',
      known: true,
      defaultBaseUrl: 'https://api.openai.com/v1',
      vision: true,
      video: false,
      effortLevels: rows[0]!.effortLevels,
    })
  })

  test('Claude、GPT-6 与 Qwen 新型号进入模型库和已配置列表', async () => {
    for (const [kind, id, vendor, label] of [
      ['anthropic_messages', 'claude-opus-5-5', 'anthropic', 'Claude Opus 5.5'],
      ['openai_responses', 'gpt-6-sol', 'openai', 'GPT-6 Sol'],
      ['openai_responses', 'gpt-6-luna', 'openai', 'GPT-6 Luna'],
      ['openai_chat_completions', 'qwen3.8-omni-flash', 'alibaba', 'Qwen3.8 Omni Flash'],
    ] as const) {
      const b = await body(withConfig(kind, id))
      const rows = b.library.find((v) => v.id === vendor)!.models.filter((m) => m.id === id)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.label).toBe(label)
      expect(b.providers[0]!.models[0]).toMatchObject({ id, label, known: true })
    }
  })

  test('MiMo 的三种协议规格同时进入模型库与已配置列表', async () => {
    for (const kind of ['openai_chat_completions', 'openai_responses', 'anthropic_messages']) {
      const b = await body(withConfig(kind, 'mimo-v2.6-pro'))
      const vendor = b.library.find((v) => v.id === 'xiaomi')!
      expect(vendor.models.map((m) => m.id)).toEqual([
        'mimo-v2.6-pro',
        'mimo-v2.6-flash',
        'mimo-v2.6-pro-ultraspeed',
      ])
      expect(vendor.models.find((m) => m.id === 'mimo-v2.6-pro')).toMatchObject({
        contextWindow: 1_000_000,
        maxOutputTokens: 131_072,
        vision: true,
        thinksByDefault: true,
        effortLevels: [],
        input: 3,
        output: 6,
        cacheRead: 0.025,
        currency: 'CNY',
      })
      expect(b.providers[0]!.models[0]).toMatchObject({
        id: 'mimo-v2.6-pro',
        label: 'MiMo V2.6 Pro',
        known: true,
        vision: true,
        effortLevels: [],
        effort: null,
      })
    }
  })

  test('GLM FlashX 与 Grok 4.7 在模型库去重，配置列表保留协议专属档位', async () => {
    for (const kind of ['openai_chat_completions', 'openai_responses']) {
      for (const [model, vendor] of [
        ['glm-5.3-flashx', 'zhipu'],
        ['grok-4.7', 'xai'],
      ] as const) {
        const b = await body(withConfig(kind, model))
        expect(
          b.library.find((v) => v.id === vendor)!.models.filter((m) => m.id === model),
        ).toHaveLength(1)
        expect(b.providers[0]!.models[0]).toMatchObject({
          id: model,
          known: true,
          vision: true,
          effortLevels:
            model === 'grok-4.7'
              ? ['low', 'medium', 'high', 'xhigh']
              : kind === 'openai_responses'
                ? ['high', 'max']
                : ['low', 'high', 'max'],
        })
      }
    }
  })

  /** 内置库不得缩减：缺少一家厂商时，设置页上该厂商的整组模型随之消失。 */
  test('内置库覆盖已收录厂商', async () => {
    const b = await body(withConfig('anthropic_messages', 'claude-opus-5'))
    expect(b.library.map((v) => v.id).sort()).toEqual([
      'alibaba',
      'anthropic',
      'deepseek',
      'google',
      'minimax',
      'moonshot',
      'openai',
      'stepfun',
      'xai',
      'xiaomi',
      'zhipu',
    ])
    const all = b.library.flatMap((v) => v.models)
    for (const id of [
      'claude-fable-5-1',
      'gpt-5.6-sol',
      'gemini-3.8-flash',
      'gemini-3.1-pro-preview',
      'grok-4.6',
      'kimi-k3',
      'glm-5.2',
    ]) {
      expect(all.some((m) => m.id === id)).toBe(true)
    }
  })

  /**
   * 以人民币标价的三家厂商必须返回币种。缺少币种时 ¥6 会显示为 $6，相差约七倍，
   * 且该错误在界面上无法察觉。
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
   * 缓存命中与写入两档单价同样须下发。
   *
   * 缺少时界面只显示输入与输出两项单价，而缓存价格决定长会话的实际费用：
   * Anthropic 写入为 input 的 1.25 倍，DeepSeek 写入不收费，
   * 只看输入与输出单价时无法看出该差别。
   */
  test('内置库带缓存命中与写入两档单价', async () => {
    const all = (await body(withConfig('anthropic_messages', 'claude-opus-5'))).library.flatMap(
      (v) => v.models,
    )
    const opus = all.find((m) => m.id === 'claude-opus-5')!
    expect(opus.cacheRead).toBe(0.5)
    expect(opus.cacheWrite).toBe(6.25)
    const fable = all.find((m) => m.id === 'claude-fable-5-1')!
    expect(fable.cacheRead).toBe(0.25)
    expect(fable.cacheWrite).toBe(12.5)
    // DeepSeek 的自动前缀缓存写入不收费，0 是实际值而非缺失值。
    expect(all.find((m) => m.id === 'deepseek-flash')?.cacheWrite).toBe(0)
  })

  /**
   * 同一模型在内置库中只出现一次。
   *
   * 目录中同一 id 的多条记录供 `lookupModel` 按协议查询能力（DeepSeek 有兼容协议与
   * Responses 两条）。协议是接口的属性，放入模型列表会让用户在两条外观相同的
   * 模型之间选择，而用户没有判断依据。
   */
  test('内置库中同一 id 只出现一次', async () => {
    const ds = (await body(withConfig('anthropic_messages', 'claude-opus-5'))).library.find(
      (v) => v.id === 'deepseek',
    )!
    expect(ds.models.map((m) => m.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
  })

  test('未收录的模型不声明支持 effort', async () => {
    const list = await models(withConfig('openai_chat_completions', '自建的'))
    expect(list.find((m) => m.id === '自建的')?.effortLevels).toEqual([])
  })

  test('未收录模型的逐档检测结果进入选择器，仅影响当前接口', async () => {
    const d = deps()
    ;(d as { config: unknown }).config = {
      active: { provider: 'tested', model: 'custom' },
      providers: {
        tested: {
          kind: 'openai_chat_completions',
          models: {
            custom: {
              effort: 'max',
              transport: {
                effort: true,
                effortLevels: ['low', 'high', 'max'],
                thinking: 'reasoning_effort',
              },
            },
          },
        },
        other: { kind: 'openai_chat_completions', models: { custom: {} } },
      },
    }
    const result = await body(d)
    const tested = result.providers.find((p) => p.name === 'tested')!.models[0]!
    expect(tested.effortLevels).toEqual(['low', 'high', 'max'])
    expect(tested.effort).toBe('max')
    expect(result.providers.find((p) => p.name === 'other')!.models[0]!.effortLevels).toEqual([])
  })

  /**
   * 内置库不含任何接口字段。
   *
   * 端点与协议是接口的属性。放入模型库后，修改一条模型参数会连带修改端点，
   * 添加一个模型可能导致其他模型无法连接。
   */
  test('内置库中没有端点、协议等接口字段', async () => {
    const b = await body(withConfig('anthropic_messages', 'claude-opus-5'))
    const ds = b.library.find((v) => v.id === 'deepseek')!
    // 比较整份键集，而不是逐个断言某些字段不存在：逐个断言只能拦截预先想到的字段，
    // 比较键集可一并拦截未想到的字段。`LibraryVendor` 在类型上同样禁止多余字段。
    expect(Object.keys(ds).sort()).toEqual(['displayName', 'id', 'models'])
  })

  /** 模型库的人工覆盖必须生效；端点探测结果单独保存在 provider.models[].transport。 */
  test('config.catalog 中的覆盖值优先于内置值', async () => {
    const d = withConfig('anthropic_messages', 'claude-opus-5')
    ;(d.config as { catalog?: unknown }).catalog = {
      'claude-opus-5|anthropic_messages': { input: 99, output: 199 },
    }
    const all = (await body(d)).library.flatMap((v) => v.models)
    expect(all.find((m) => m.id === 'claude-opus-5')?.input).toBe(99)
  })

  /**
   * 目录中未收录的模型，用户添加参数后必须出现在模型库中。
   *
   * 否则未收录模型按 0 计价、用量显示 $0 的问题仍无法解决，
   * 而这正是增加这一层的原因。
   */
  test('用户添加的模型进入模型库，按 vendor 分组', async () => {
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

  /** 未填写 vendor 的模型归入「自定义」，不静默丢弃。 */
  test('未指定厂商的模型归入自定义分组', async () => {
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
 * 多项目：确定本次请求所指的项目。
 *
 * 项目根目录由 `?ws=` 逐请求解析，不存为进程级常量：存为常量时切换项目
 * 需要重启 sidecar。以下三个用例锁定该契约。
 */
describe('按 ?ws= 解析项目', () => {
  function twoProjects() {
    const store = new Store({ path: ':memory:' })
    const a = upsertWorkspace(store, '/ws/a', 'a')
    const b = upsertWorkspace(store, '/ws/b', 'b')
    return { d: { store } as unknown as ApiDeps, a, b }
  }

  test('带 ?ws= 时使用指定的项目，而非最近打开的项目', async () => {
    const { d, a, b } = twoProjects()
    // b 后 upsert，缺省时会选中它，因此本用例能证明参数生效。
    const res = await call(`/api/workspace?ws=${a.id}`, undefined, d)
    expect(await res?.json()).toEqual({ id: a.id, root: resolve('/ws/a'), name: 'a' })
    const fallback = await call('/api/workspace', undefined, d)
    expect(((await fallback?.json()) as { id: string }).id).toBe(b.id)
  })

  test('添加项目：不是本机已存在的目录时返回 422，且不落盘', async () => {
    const { d } = twoProjects()
    const res = await call(
      '/api/workspaces',
      {
        method: 'POST',
        body: JSON.stringify({ path: '/ws/不存在的目录' }),
      },
      d,
    )
    expect(res?.status).toBe(422)
    const list = (await (await call('/api/workspaces', undefined, d))!.json()) as {
      workspaces: unknown[]
    }
    expect(list.workspaces.length).toBe(2)
  })

  test('添加项目：已存在时只更新最近打开时间，不插入第二行', async () => {
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
 * 工具清单的下发内容。
 *
 * 锁定设置页能否取得底层工具名与参数：`ToolSpec` 的字段在服务端被丢弃时，
 * 前端即使已实现也无法显示，界面上只表现为缺少一列，不报任何错误。
 *
 * `QYWORK_HOME` 指向临时目录：插件与 MCP 有三层作用域，不隔离时本测试
 * 会连接开发者本机全局安装的 server。
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

  test('每行包含底层名、动作、权限与来源，而不只有中文用途', async () => {
    const row = (await tools()).find((t) => t.name === 'read_file')
    expect(row).toBeDefined()
    expect(row?.actionKind).toBe('read')
    expect(row?.permissionEffect).toBe('read')
    expect(row?.objectLabel).toBe('文件')
    expect(row?.source).toBe('builtin')
  })

  test('参数只返回名称与是否必填，不下发整份 schema', async () => {
    const row = (await tools()).find((t) => t.name === 'read_file')
    expect(row?.params).toEqual([
      { name: 'path', required: true },
      { name: 'offset', required: false },
      { name: 'limit', required: false },
      { name: 'start', required: false },
      { name: 'end', required: false },
    ])
    // 整份 schema 的体积由第三方 server 决定，不受控制，因此不下发其中任何键
    expect(row).not.toHaveProperty('parameters')
    expect(row).not.toHaveProperty('description')
  })

  test('没有参数的工具返回空数组，而不是缺少该键', async () => {
    const row = (await tools()).find((t) => t.name === 'list_schedules')
    expect(row?.params).toEqual([])
  })

  test('load_tool 出现在清单中：它不在 registerBuiltinTools 中，遗漏时页面缺少一行', async () => {
    const row = (await tools()).find((t) => t.name === 'load_tool')
    expect(row?.source).toBe('builtin')
    expect(row?.params).toEqual([{ name: 'names', required: true }])
    // 它不是常驻工具，用途中必须写明这一边界，否则页面描述与实际不符
    expect(row?.summary).toContain('超过阈值')
  })

  /**
   * 按通道注册的两组工具都必须列出。缺少一个通道时不会报错，而是「模块」页中该组
   * 只剩说明行，看起来像该能力没有工具。
   */
  test('浏览器与电脑控制的工具均列出', async () => {
    const rows = await tools()
    const names = rows.map((t) => t.name)
    for (const name of [
      'desktop_windows',
      'desktop_observe',
      'desktop_act',
      'desktop_act_sequence',
      'desktop_wait',
    ]) {
      expect(names).toContain(name)
    }
    expect(names).toContain('browser_tabs')
    const row = rows.find((t) => t.name === 'desktop_act')
    expect(row?.category).toBe('desktop')
    expect(row?.permissionEffect).toBe('desktop')
    expect(row?.source).toBe('builtin')
  })

  /**
   * 「模块」页按类目分组。内置工具中只有管理 MCP 配置的工具归入 `mcp`、安装插件的工具归入 `plugins`；
   * 画布与生成工具标为这两类时，会与 MCP server 提供的工具列在同一组。
   */
  test('内置工具按领域分组：画布与生成自成一类，MCP 与插件各自一类', async () => {
    const rows = await tools()
    const category = (name: string) => rows.find((t) => t.name === name)?.category
    for (const name of [
      'create_canvas',
      'read_canvas',
      'edit_canvas',
      'run_canvas',
      'retrieve_canvas',
      'retrieve_media',
      'generate_image',
      'generate_video',
      'generate_audio',
    ])
      expect(category(name)).toBe('media')
    const builtinIn = (c: string) =>
      rows
        .filter((t) => t.source === 'builtin' && t.category === c)
        .map((t) => t.name)
        .sort()
    expect(builtinIn('mcp')).toEqual(['move_mcp_server', 'write_mcp_server'])
    expect(builtinIn('plugins')).toEqual(['install_plugin'])
  })

  test('只返回 tools 一个键：mcpServers 没有任何消费者', async () => {
    const res = await call('/api/tools')
    expect(Object.keys((await res?.json()) as object)).toEqual(['tools'])
  })

  test('工具目录列出 Office 与协作工具，画布参数按职责拆分', async () => {
    const rows = await tools()
    const names = rows.map((row) => row.name)
    expect(names).not.toContain('canvas')
    expect(names).not.toContain('office')
    for (const name of ['read_office_guide', 'read_office', 'write_office', 'view_office']) {
      const row = rows.find((row) => row.name === name)
      expect(row?.category).toBe('office')
      expect(row?.permissionEffect).toBe(name === 'write_office' ? 'execute' : 'read')
      expect(row?.params.map((param) => param.name)).not.toContain('action')
    }
    for (const name of ['subagent', 'workflow', 'define_role']) expect(names).toContain(name)
    for (const name of ['create_canvas', 'edit_canvas', 'run_canvas', 'retrieve_canvas']) {
      expect(
        rows.find((row) => row.name === name)?.params.map((param) => param.name),
      ).not.toContain('action')
    }
  })

  /**
   * `write_todos` 首次创建时为「创建」、之后为「修改」；write_file 按 mode 区分新建与覆盖修改；
   * `browser_tabs` 的 list 读取清单，create / bind / close 改变本会话持有的页，
   * 这些动作随参数变化，工具清单如实显示「不固定」。
   * 权限效果不得为函数：该列是安全边界，不固定等于未声明。
   */
  test('待办、文件写入与浏览器标签按参数区分动作，权限效果固定', async () => {
    for (const row of await tools()) {
      expect(row.permissionEffect).not.toBe('不固定')
      expect(row.objectLabel).not.toBe('不固定')
      if (row.actionKind === '不固定')
        expect(['write_todos', 'write_file', 'browser_tabs']).toContain(row.name)
    }
  })
})

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
    // 没有运行中的 run 时不返回运行中快照，界面因此不会把已结束的轮次渲染为执行中。
    expect(page.live).toBeNull()
  })

  /**
   * 运行中轮次的只读快照。事件环有界，断线时间较长时无法补齐，刷新后只能从此处恢复
   * 当前请求所处的阶段。每个字段都必须能在 `provider_requests` 的对应行中找到来源。
   */
  test('运行中返回 live 快照：阶段时刻与次数均来自请求账', async () => {
    const d = deps()
    const workspaceId = (d as unknown as { wsId: string }).wsId
    const conv = createConversation(d.store, {
      workspaceId: workspaceId as never,
      provider: 'p',
      model: 'm',
    })
    const msg = appendMessage(d.store, {
      conversationId: conv.id,
      role: 'user',
      content: '继续',
      attachments: [],
    })
    const run = createRun(d.store, {
      conversationId: conv.id,
      workspaceId: workspaceId as never,
      model: 'm',
      clientRequestId: 'live-1',
      userMessageId: msg.id,
      messageIdUpperBound: msg.id,
      contextSnapshot: [],
    })
    ;(d.runs as unknown as { runId: RunId | null }).runId = run.id

    const open = (retryIndex: number) =>
      openProviderRequest(d.store, {
        runId: run.id,
        turnIndex: 0,
        retryIndex,
        purpose: 'turn',
        providerKind: 'openai_chat_completions',
        model: 'm',
        measuredInputTokens: 10,
        sentCategories: {} as never,
        omittedCategories: {} as never,
        payloadHash: 'h',
      })

    // 第一次被拒绝并安排重发；第二次已发出、已收到响应头并返回过内容。
    const failed = open(0)
    markProviderRequestSent(d.store, failed.id)
    settleProviderRequest(d.store, failed.id, 'rejected', null, 'provider_unavailable')
    recordProviderRequestDiagnostic(d.store, failed.id, {
      causes: [],
      providerEvents: 0,
      silentMs: 0,
      transport: null,
      assistantChars: 0,
      toolCallCount: 0,
      retry: { decision: 'resend', attempt: 1, max: 5, backoffMs: 60_000, at: 1_700_000_000_000 },
    })
    const live = open(1)
    markProviderRequestSent(d.store, live.id)
    markProviderRequestHeaders(d.store, live.id, 1_700_000_061_000)
    markProviderRequestContent(d.store, live.id, 1_700_000_062_000, 'thinking', true)
    markProviderRequestContent(d.store, live.id, 1_700_000_065_000, 'tool_arguments', false)

    const res = await call(`/api/conversations/${conv.id}/history`, undefined, d)
    const page = (await res?.json()) as ConversationHistoryPageResponse
    expect(page.live?.runId).toBe(run.id)
    // 事件序号边界在请求时从总线读取：客户端据此判定快照与实时事件哪一方更新。
    expect(page.live?.seq).toBe(77)
    expect(page.live?.request).toMatchObject({
      requestId: live.id,
      // 次数取自上一行的重发裁决，而非 `retry_index`：后者在每个 turn 中从 0 开始。
      attempt: 1,
      max: 5,
      status: 'in_flight',
      headersAt: 1_700_000_061_000,
      firstContentAt: 1_700_000_062_000,
      lastContentAt: 1_700_000_065_000,
      lastContentKind: 'tool_arguments',
      lastVisibleAt: 1_700_000_062_000,
      // 下一次请求已发出，退避结束，倒计时不再有截止点。
      backoffUntil: null,
    })
    expect(page.live?.request?.sentAt).toBeNumber()
  })

  /** 退避期间：最近一行已进入终态且裁决为重发，截止点由等待起点加退避时长计算。 */
  test('退避期间的 live 快照给出倒计时截止点', async () => {
    const d = deps()
    const workspaceId = (d as unknown as { wsId: string }).wsId
    const conv = createConversation(d.store, {
      workspaceId: workspaceId as never,
      provider: 'p',
      model: 'm',
    })
    const run = createRun(d.store, {
      conversationId: conv.id,
      workspaceId: workspaceId as never,
      model: 'm',
      clientRequestId: 'live-2',
      userMessageId: null,
      messageIdUpperBound: null,
      contextSnapshot: [],
    })
    ;(d.runs as unknown as { runId: RunId | null }).runId = run.id
    const failed = openProviderRequest(d.store, {
      runId: run.id,
      turnIndex: 0,
      retryIndex: 0,
      purpose: 'turn',
      providerKind: 'openai_chat_completions',
      model: 'm',
      measuredInputTokens: 10,
      sentCategories: {} as never,
      omittedCategories: {} as never,
      payloadHash: 'h',
    })
    markProviderRequestSent(d.store, failed.id)
    settleProviderRequest(d.store, failed.id, 'rejected', null, 'provider_unavailable')
    recordProviderRequestDiagnostic(d.store, failed.id, {
      causes: [],
      providerEvents: 0,
      silentMs: 0,
      transport: null,
      assistantChars: 0,
      toolCallCount: 0,
      retry: { decision: 'resend', attempt: 2, max: 5, backoffMs: 60_000, at: 1_700_000_000_000 },
    })

    const res = await call(`/api/conversations/${conv.id}/history`, undefined, d)
    const page = (await res?.json()) as ConversationHistoryPageResponse
    expect(page.live?.request).toMatchObject({
      requestId: failed.id,
      attempt: 2,
      max: 5,
      status: 'rejected',
      lastContentAt: null,
      backoffUntil: 1_700_000_060_000,
    })
  })

  test('非法页大小返回 422，不静默改为其他值', async () => {
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
  test('只导出路径中指定的会话，并以 JSON 附件返回', async () => {
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
      source: 'temp',
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
        nodes: { child: { phase: 'done', label: '调查', subagentId: child.id } },
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
    expect(payload.schemaVersion).toBe(8)
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

  /**
   * 运行页统计整条会话的费用，而子 agent 的费用记在其自身的会话上。
   * 不按父子树读取时，子会话产生的费用不会在该页显示。
   */
  test('会话用量与轮次含子会话，币种分桶', async () => {
    const d = deps()
    const parent = createConversation(d.store, {
      workspaceId: d.wsId as never,
      provider: 'p',
      model: 'm',
    })
    const kids = ['GLM 车组', 'Qwen 车组'].map((name) =>
      createConversation(d.store, {
        workspaceId: d.wsId as never,
        provider: 'p',
        model: 'm',
        title: name,
        source: 'temp',
        parentConversationId: parent.id,
      }),
    )
    const bill = (conversationId: string, cost: number, currency?: 'CNY') => {
      recordUsage(d.store, {
        kind: 'run',
        conversationId,
        model: 'm',
        provider: 'p',
        inputTokens: 10,
        outputTokens: 5,
        cachedTokens: null,
        reasoningTokens: 0,
        cost,
        ...(currency ? { currency } : {}),
      })
    }
    bill(parent.id, 1)
    bill(kids[0]!.id, 2)
    bill(kids[1]!.id, 4, 'CNY')
    for (const conversation of [parent, ...kids]) {
      const run = createRun(d.store, {
        conversationId: conversation.id,
        workspaceId: d.wsId as never,
        model: 'm',
        clientRequestId: `req_${conversation.id}`,
        userMessageId: null,
        messageIdUpperBound: null,
        contextSnapshot: [],
      })
      finishRun(d.store, run.id, { status: 'done', stopReason: 'completed' })
    }

    const usage = (await (
      await call(`/api/conversations/${parent.id}/usage`, undefined, d)
    )?.json()) as ConversationUsageResponse
    expect(usage.totals.entries).toBe(3)
    expect(usage.totals.cost.USD).toBeCloseTo(3, 6)
    expect(usage.totals.cost.CNY).toBeCloseTo(4, 6)

    const runs = (await (
      await call(`/api/conversations/${parent.id}/runs`, undefined, d)
    )?.json()) as ConversationRunsResponse
    expect(runs.runs).toHaveLength(1)
    expect(runs.childRuns.map((row) => row.name).sort()).toEqual(['GLM 车组', 'Qwen 车组'])
    expect(runs.childRuns.every((row) => row.run.id !== runs.runs[0]?.id)).toBe(true)
  })

  test('不存在的会话返回 404，不生成空诊断包', async () => {
    const res = await call('/api/conversations/cv_nope/export')
    expect(res?.status).toBe(404)
  })
})

/*
 * 会话行上的三个操作：重命名、归档、硬删除。
 *
 * 三个操作都会修改账本，因此每个操作的拒绝路径也须锁定：静默成功的写接口
 * 在界面上与「成功但未产生任何变化」无法区分。
 */
describe('会话的重命名 / 归档 / 删除', () => {
  const conv = (d: ApiDeps & { wsId: string }) =>
    createConversation(d.store, { workspaceId: d.wsId as never, provider: 'p', model: 'm' })

  test('PATCH 修改标题，返回修改后的记录', async () => {
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

  /* 空名称在侧栏中回退显示为「新对话」，界面上等同于重命名未生效，
     因此返回 422 且不落盘（校验先于落盘）。 */
  test('空标题返回 422 且不落盘', async () => {
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

  test('修改不存在的会话返回 404', async () => {
    const res = await call('/api/conversations/cv_nope', {
      method: 'PATCH',
      body: JSON.stringify({ title: 'x' }),
    })
    expect(res?.status).toBe(404)
  })

  /* 归档只写入标记：会话从列表中移除，按 id 仍可读取。 */
  test('归档后不出现在列表中，数据保留', async () => {
    const d = deps()
    const c = conv(d)
    const res = await call(`/api/conversations/${c.id}/archive`, { method: 'POST' }, d)
    expect(res?.status).toBe(200)
    expect(listConversations(d.store, d.wsId as never).map((x) => x.id)).not.toContain(c.id)
    expect(getConversation(d.store, c.id)).not.toBeNull()
  })

  /*
   * 归档保留页面，删除关闭页面。两种情况都须测试：只测其中一种时，关页调用移到另一个操作上
   * 测试仍会通过，而归档后页签会被关闭。
   */
  test('归档不关闭内置浏览器页，删除时关闭', async () => {
    const d = deps()
    const closed: string[] = []
    d.closeBrowserPages = (id) => {
      closed.push(id)
      return Promise.resolve()
    }
    const archived = conv(d)
    const res = await call(`/api/conversations/${archived.id}/archive`, { method: 'POST' }, d)
    expect(res?.status).toBe(200)
    expect(closed).toEqual([])

    const deleted = conv(d)
    const gone = await call(`/api/conversations/${deleted.id}`, { method: 'DELETE' }, d)
    expect(gone?.status).toBe(200)
    expect(closed).toEqual([deleted.id])
  })

  /* 硬删除即实际删除：本用例锁定删除后记录不存在，而不只是从列表中消失。 */
  test('DELETE 为硬删除，账本中的记录被删除', async () => {
    const d = deps()
    const c = conv(d)
    const res = await call(`/api/conversations/${c.id}`, { method: 'DELETE' }, d)
    expect(res?.status).toBe(200)
    expect(getConversation(d.store, c.id)).toBeNull()
  })

  /*
   * 运行中的会话不可删除：级联会删除 run / step，而该轮仍在写入。
   * 这是唯一会留下悬空引用的情况，因此必须拒绝，而不是尽力执行。
   */
  test('正在执行的会话返回 409，且记录保留', async () => {
    const d = deps()
    const c = conv(d)
    ;(d as { runs: unknown }).runs = { isBusy: () => true }
    const res = await call(`/api/conversations/${c.id}`, { method: 'DELETE' }, d)
    expect(res?.status).toBe(409)
    expect(getConversation(d.store, c.id)).not.toBeNull()
  })

  test('删除不存在的会话返回 404，不静默成功', async () => {
    const res = await call('/api/conversations/cv_nope', { method: 'DELETE' })
    expect(res?.status).toBe(404)
  })

  /* 同一路径的 GET 不由这些路由处理：方法参与匹配，否则读请求会命中写操作的分支。 */
  test('GET /api/conversations/:id 不由任何模块处理', async () => {
    const d = deps()
    const c = conv(d)
    expect(await call(`/api/conversations/${c.id}`, undefined, d)).toBe(null)
  })
})

describe('会话变更分页接口', () => {
  test('按写入过文件的轮次分页，附带整个会话的合计与游标', async () => {
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
        content: `改动 ${i}`,
      })
      ids.push(msg.id)
      const run = createRun(d.store, {
        conversationId: conv.id,
        workspaceId: workspaceId as never,
        model: 'm',
        clientRequestId: `changes-${i}`,
        userMessageId: msg.id,
        messageIdUpperBound: msg.id,
        contextSnapshot: [],
      })
      appendStep(d.store, {
        runId: run.id,
        seq: 1,
        kind: 'tool_action',
        toolName: 'write_file',
        status: 'success',
        payload: {
          kind: 'tool_result',
          args: { path: `f${i}.ts`, content: 'x' },
          outcome: {
            status: 'success',
            executed: true,
            message: '',
            fileChanges: [{ path: `f${i}.ts`, changeType: 'created', additions: i, deletions: 0 }],
          },
        },
      })
      finishRun(d.store, run.id, { status: 'done', stopReason: 'completed' })
    }

    const res = await call(`/api/conversations/${conv.id}/changes?limit=1`, undefined, d)
    expect(res?.status).toBe(200)
    const page = (await res?.json()) as ConversationChangesPageResponse
    expect(page.turns.map((t) => t.text)).toEqual(['改动 2'])
    expect(page.turns[0]?.steps.map((s) => s.toolName)).toEqual(['write_file'])
    expect(page.totals).toEqual({ paths: ['f1.ts', 'f2.ts'], additions: 3, deletions: 0 })
    expect(page.nextCursor).toBe(ids[1]!)
  })

  test('非法页大小返回 422', async () => {
    const d = deps()
    const workspaceId = (d as unknown as { wsId: string }).wsId
    const conv = createConversation(d.store, {
      workspaceId: workspaceId as never,
      provider: 'p',
      model: 'm',
    })
    const res = await call(`/api/conversations/${conv.id}/changes?limit=0`, undefined, d)
    expect(res?.status).toBe(422)
  })
})
