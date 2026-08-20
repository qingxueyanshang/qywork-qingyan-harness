/**
 * 插件。
 *
 * ## 只有全局一个目录
 *
 * `~/.qywork/plugins/`。插件贡献的是工具、预览器、供应商——那些是这个 agent 的
 * 能力，不是某个仓库的内容。所以它不分层，接口上也就没有 `scope` 参数：
 * 装一次对所有项目生效。「这个项目要不要加载某个插件」是开关，不是第二份拷贝。
 *
 * 页面叫「插件」，**不叫市场**。这个项目没有中心 registry，也不该现造一个：
 * 一个叫「市场」而里面没有任何可安装内容的页面，就是把这次要删的空壳
 * 换个名字再造一遍（ROADMAP §34.3）。
 *
 * 数据源与 `qy plugins` 完全相同（loadExtensions），所以 CLI 与界面不会
 * 对「装了什么、隔离到什么程度」给出两种答案。
 *
 * 失败项与成功项一起回：装失败的插件恰恰是用户最需要看到的那部分，
 * 只回成功的会让「我明明放进去了怎么没有」无从查起。
 */

import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { globalPluginsDir } from '@qywork/runtime'
import { type ApiHandler, json } from './types.ts'

/**
 * 「新建」落下去的那份骨架。
 *
 * **它是能跑的**：装完重启就有一个 `<id>__echo` 工具，调一次能看到回声。
 * 落一堆 `TODO` 下去的话，用户拿到的是一个必然报错的插件，而报错的原因
 * （握手没回 `ready`）和他要写的业务毫无关系。
 *
 * 协议就是 `docs/plugins.md` 写的那一份：一行一个 JSON，`ready` 之后收 `call`。
 */
const SKELETON = [
  "const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')",
  '',
  "let buf = ''",
  "process.stdin.setEncoding('utf8')",
  "process.stdin.on('data', (chunk) => {",
  '  buf += chunk',
  '  let i',
  "  while ((i = buf.indexOf('\\n')) >= 0) {",
  '    const line = buf.slice(0, i)',
  '    buf = buf.slice(i + 1)',
  '    if (!line.trim()) continue',
  '    let msg',
  '    try {',
  '      msg = JSON.parse(line)',
  '    } catch {',
  '      continue',
  '    }',
  "    if (msg.type !== 'call') continue",
  '    // 换成你自己的实现。宿主能力走 host(...)，见 docs/plugins.md。',
  '    send({',
  '      id: msg.id,',
  '      ok: true,',
  "      result: { status: 'success', message: String(msg.params?.text ?? '') },",
  '    })',
  '  }',
  '})',
  '',
  "send({ type: 'ready' })",
  '',
].join('\n')

export const handlePluginsApi: ApiHandler = async (url, req, d) => {
  const p = url.pathname

  if (p === '/api/plugins') {
    const { loadExtensions } = await import('@qywork/runtime')
    const ext = await loadExtensions(d.workspaceRoot)
    const reg = ext.plugins
    return json({
      dir: globalPluginsDir(),
      plugins: reg.plugins.map((pl) => {
        const rt = pl.host?.runtime
        return {
          id: pl.manifest.id,
          name: pl.manifest.name,
          version: pl.manifest.version,
          permissions: pl.manifest.permissions ?? [],
          tools: reg.toolSpecs
            .filter((t) => t.name.startsWith(`${pl.manifest.id}__`))
            .map((t) => ({ name: t.name, description: t.description })),
          // 纯声明式插件没有进程，也就无所谓隔离。这三种状态必须分开报——
          // 把「不适用」显示成「无隔离」会让人以为出了安全问题。
          process: !pl.host ? 'declarative' : rt ? 'running' : 'unknown',
          ...(rt ? { sandboxed: rt.sandboxed, netGuarded: rt.netGuarded, note: rt.note } : {}),
        }
      }),
      failures: reg.failures.map((f) => ({ dir: f.dir, reason: f.reason })),
    })
  }

  // 安装 / 卸载插件。
  //
  // ## 「安装」只有一种形式：把一个目录放进某一层的 plugins/
  //
  // 没有中心 registry，所以没有「从市场安装」。来源只能是**本机已经存在的目录**——
  // 用户先自己 clone 或下载，看过内容，再指给这里。
  //
  // **刻意不做 `git clone <任意 URL>`**：那等于「从网上取一段代码，下一次加载就跑它」。
  // 插件确实跑在沙箱里，但沙箱管的是它能碰什么，不管它是不是你想要的东西。
  // 少这一步的代价只是用户多敲一条 git 命令，而多这一步的代价是这个入口
  // 变成一条 `curl | sh`。同样的结果照样能达成，只是中间多一次「你看到了自己装的是什么」。
  //
  // ## 装之前必须校验清单
  //
  // 目录里没有合法的 `qywork.plugin.json` 就直接拒绝。不校验的话，
  // 指错目录会「安装成功」然后在下一次加载时变成一条 failure——
  // 而那时候用户已经不记得自己指了哪里。
  if (p === '/api/plugins/install' && req.method === 'POST') {
    const body = (await req.json().catch(() => null)) as { path?: string } | null
    const src = body?.path?.trim()
    if (!src) return json({ error: 'bad request', message: '缺少目录路径' }, 400)

    const manifestPath = join(src, 'qywork.plugin.json')
    const raw = await readFile(manifestPath, 'utf8').catch(() => null)
    if (raw === null) {
      return json({ error: 'invalid', message: `目录里没有 qywork.plugin.json：${src}` }, 422)
    }
    let id: string
    try {
      const { parseManifest } = await import('@qywork/plugins')
      id = parseManifest(JSON.parse(raw), manifestPath).id
    } catch (e) {
      return json({ error: 'invalid', message: `清单不合法：${(e as Error).message}` }, 422)
    }

    const dest = join(globalPluginsDir(), id)
    // 已经装过同 id 的就拒绝，而不是静默覆盖：覆盖会把用户可能改过的
    // 那一份直接抹掉，且没有任何提示。要换版本先卸载。
    if (await stat(dest).catch(() => null)) {
      return json({ error: 'conflict', message: `已经装了同名插件 ${id}，请先卸载` }, 409)
    }
    // 源目录就是目标目录时直接返回：那说明用户指的是已经装好的那一个。
    if (resolve(src) === resolve(dest)) return json({ ok: true, id })

    await mkdir(dirname(dest), { recursive: true })
    await cp(src, dest, { recursive: true })
    return json({ ok: true, id })
  }

  /**
   * 新建一个插件骨架。
   *
   * **落的是一份能跑起来的插件**，不是一堆 TODO：清单 + 一个 echo 工具的入口。
   * 用户拿到之后改的是业务，不用先跟协议较劲。
   *
   * id 是命名空间前缀，工具名按它拼（`demo.echo` → `demo_echo__echo`），
   * 所以它和目录名一样要挡住分隔符。
   */
  if (p === '/api/plugins/new' && req.method === 'POST') {
    const body = (await req.json().catch(() => null)) as {
      id?: string
      name?: string
      description?: string
    } | null
    const id = body?.id?.trim() ?? ''
    if (!id) return json({ error: 'bad request', message: '缺少 id' }, 400)
    if (!/^[a-zA-Z0-9._-]+$/.test(id)) {
      return json({ error: 'invalid', message: 'id 只能用字母、数字、点、下划线、连字符' }, 422)
    }

    const dest = join(globalPluginsDir(), id)
    // 已经装过同 id 的就拒绝，而不是静默覆盖：覆盖会把用户写过的代码抹掉。
    if (await stat(dest).catch(() => null)) {
      return json({ error: 'conflict', message: `已经有一个 ${id} 了，先卸载或换个 id` }, 409)
    }
    await mkdir(dest, { recursive: true })
    const manifest = {
      manifestVersion: 1,
      id,
      name: body?.name?.trim() || id,
      version: '0.1.0',
      description: body?.description?.trim() || '',
      main: 'index.mjs',
      // 骨架工具声明 `read`，清单里就必须有 `workspace:read`——`parseManifest`
      // 把这一对当硬约束（工具能干的事和插件声明的权限必须自洽），少一边整个插件
      // 加载失败。骨架落地就跑不起来的话，用户看到的第一条信息是一个和他要写的
      // 业务毫无关系的报错。
      permissions: ['workspace:read'],
      contributes: {
        tools: [
          {
            name: 'echo',
            description: '把参数原样返回。换成你自己的工具。',
            parameters: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
              additionalProperties: false,
            },
            permissionEffect: 'read',
          },
        ],
      },
    }
    await writeFile(
      join(dest, 'qywork.plugin.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    )
    await writeFile(join(dest, 'index.mjs'), SKELETON, 'utf8')
    return json({ ok: true, id, dir: dest })
  }

  const pluginMatch = /^\/api\/plugins\/([^/]+)$/.exec(p)
  if (pluginMatch && req.method === 'DELETE') {
    const id = pluginMatch[1]!
    // id 来自 URL，必须挡住 `..` 之类——否则这就是一条任意目录删除。
    if (id.includes('/') || id.includes('\\') || id.includes('..')) {
      return json({ error: 'bad request' }, 400)
    }
    const target = join(globalPluginsDir(), id)
    if (!(await stat(target).catch(() => null))) return json({ error: 'not found' }, 404)
    await rm(target, { recursive: true, force: true })
    return json({ ok: true })
  }

  return null
}
