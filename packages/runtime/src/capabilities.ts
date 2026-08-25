/**
 * 宿主能力实现 —— 插件通过 RPC 能做的全部事情。
 *
 * 插件进程本身没有 `fs`、没有 `net`、没有 `child_process`（见 `plugins/host.ts`），
 * 它想干任何事都得从这里过。所以这个文件同时是**功能面**和**攻击面**：
 * 每加一个方法，就是给不受信任的第三方代码开一扇窗。
 *
 * 三层闸门，缺一不可：
 *
 * 1. **权限**（`plugins/loader.ts` → `checkPermission`）——manifest 没声明就进不来。
 * 2. **边界**（这里）——声明了 `workspace:read` 不等于能读 `../../.ssh/id_rsa`；
 *    声明了 `network` 不等于能打 `http://169.254.169.254/`。
 * 3. **配额**（这里）——不限量的读文件和不限量的命令输出都能把宿主撑爆，
 *    而插件不需要写恶意代码就能做到，一个 bug 就够了。
 *
 * **一条容易漏的：exec 的环境变量。** `run_command` 内置工具是把 `process.env` 整个透传给子进程的
 * ——那是用户自己的命令，本来就该看到自己的环境。**插件的 exec 绝不能这样**：宿主费劲把插件进程的
 * env 洗干净（不给 API Key、不给令牌），如果它转手能 `exec.run` 一句 `echo $ANTHROPIC_API_KEY`，那
 * 道清洗就等于没做。
 */

import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  collectProcess,
  displayPath,
  PROTECTED_DIRS,
  resolveInWorkspace,
  type SafetyOptions,
  safeFetch,
  spawnGuarded,
} from '@qywork/tools'

/** 单次 fs.read 的上限。插件不该用它读大文件——那是 read_resource 的事。 */
const MAX_READ_BYTES = 4 * 1024 * 1024
/** 单次 fs.write 的上限。 */
const MAX_WRITE_BYTES = 8 * 1024 * 1024
/** exec 的输出上限，stdout / stderr 各算各的。 */
const MAX_EXEC_OUTPUT = 512 * 1024
const DEFAULT_EXEC_TIMEOUT_MS = 30_000
const MAX_EXEC_TIMEOUT_MS = 300_000
/** 单个插件的私有存储上限。KV 不是数据库，超了说明用错了。 */
const MAX_STORAGE_BYTES = 2 * 1024 * 1024
/** fs.list 单次返回的条目上限。 */
const MAX_LIST_ENTRIES = 2000

export const PLUGIN_DATA_DIR = '.qy/plugin-data'

export interface CapabilityOptions {
  workspaceRoot: string
  /** 插件私有存储根。默认 `<workspaceRoot>/.qy/plugin-data`。 */
  storageRoot?: string
  /** 出网策略，与 web_fetch 共用同一套 SSRF 闸。 */
  netPolicy?: SafetyOptions
}

export type CapabilityHandler = (
  method: string,
  params: Record<string, unknown>,
  pluginId: string,
) => Promise<unknown>

/**
 * 已登记的方法清单。
 *
 * 唯一的消费者是回归测试：它逐条调过去，断言没有一条落到 default 分支的
 * 「尚未实现」。这样清单和 switch 不可能各走各的——加了方法忘了登记会红，
 * 登记了没实现也会红。`docs/plugins.md` 那张表照着它写。
 *
 * 刻意**不**放进握手的能力声明里：那个字段目前没有任何客户端会读，
 * 加一个没人消费的协议成员正是第 11 节反复在修的那一类。
 */
export const HOST_CAPABILITIES = [
  'fs.read',
  'fs.list',
  'fs.stat',
  'fs.write',
  'fs.delete',
  'net.fetch',
  'exec.run',
  'storage.get',
  'storage.set',
  'storage.delete',
  'storage.list',
] as const

export function makeCapabilityHandler(opts: CapabilityOptions): CapabilityHandler {
  const { workspaceRoot } = opts
  const storageRoot = opts.storageRoot ?? join(workspaceRoot, PLUGIN_DATA_DIR)

  const inWorkspace = (raw: unknown, mustExist: boolean) =>
    resolveInWorkspace(workspaceRoot, String(raw ?? ''), { mustExist })

  return async (method, params, pluginId) => {
    switch (method) {
      case 'fs.read': {
        const path = await inWorkspace(params.path, true)
        const info = await stat(path)
        if (!info.isFile()) throw new Error(`不是文件：${displayPath(workspaceRoot, path)}`)
        if (info.size > MAX_READ_BYTES) {
          throw new Error(
            `文件超出插件读取上限（${info.size} > ${MAX_READ_BYTES} 字节）：${displayPath(workspaceRoot, path)}`,
          )
        }
        // base64 是给二进制用的。默认 utf8——绝大多数插件读的是文本，
        // 让它们每次都自己解码是白付一次转换。
        if (params.encoding === 'base64') {
          return {
            content: Buffer.from(await readFile(path)).toString('base64'),
            encoding: 'base64',
          }
        }
        return { content: await readFile(path, 'utf8'), encoding: 'utf8' }
      }

      case 'fs.list': {
        const path = await inWorkspace(params.path ?? '.', true)
        const entries = await readdir(path, { withFileTypes: true })
        // 截断要**说出来**。静默截断会让插件把这一页当成整个目录，
        // 它「处理完了所有文件」的结论因此是错的。
        const truncated = entries.length > MAX_LIST_ENTRIES
        return {
          entries: entries.slice(0, MAX_LIST_ENTRIES).map((e) => ({
            name: e.name,
            kind: e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'symlink' : 'file',
          })),
          truncated,
          ...(truncated ? { total: entries.length } : {}),
        }
      }

      case 'fs.stat': {
        const path = await inWorkspace(params.path, true)
        const info = await stat(path)
        return {
          kind: info.isDirectory() ? 'dir' : 'file',
          size: info.size,
          mtimeMs: Math.floor(info.mtimeMs),
        }
      }

      case 'fs.write': {
        const content = String(params.content ?? '')
        const bytes = Buffer.byteLength(content, 'utf8')
        if (bytes > MAX_WRITE_BYTES) {
          throw new Error(`写入超出上限（${bytes} > ${MAX_WRITE_BYTES} 字节）`)
        }
        const path = await inWorkspace(params.path, false)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, content, { encoding: 'utf8', flag: params.append ? 'a' : 'w' })
        return { path: displayPath(workspaceRoot, path), bytes }
      }

      case 'fs.delete': {
        const path = await inWorkspace(params.path, true)
        // 不给 recursive：一个插件误删整棵目录树和误删一个文件，
        // 后果差着数量级，而它几乎没有正当理由需要前者。
        const info = await stat(path)
        if (info.isDirectory()) {
          throw new Error(`拒绝删除目录（只允许删文件）：${displayPath(workspaceRoot, path)}`)
        }
        await rm(path)
        return { deleted: displayPath(workspaceRoot, path) }
      }

      case 'net.fetch': {
        const url = String(params.url ?? '')
        if (!url) throw new Error('缺少 url')
        // 与 web_fetch 走同一个闸：每跳重定向重新校验、按解析后的 IP 分类。
        // 插件这条路更需要它——URL 完全由第三方代码构造。
        const res = await safeFetch(url, {
          ...(opts.netPolicy ?? {}),
          ...(typeof params.method === 'string' ? { method: params.method } : {}),
          ...(params.headers && typeof params.headers === 'object'
            ? { headers: params.headers as Record<string, string> }
            : {}),
          ...(typeof params.body === 'string' ? { body: params.body } : {}),
        })
        if (res.blocked) {
          throw new Error(`${res.blocked.message}（规则：${res.blocked.reason}）`)
        }
        return {
          status: res.status,
          url: res.url,
          contentType: res.contentType ?? null,
          body: new TextDecoder('utf-8').decode(res.body),
          redirects: res.redirects,
        }
      }

      case 'exec.run': {
        const command = String(params.command ?? '').trim()
        if (!command) throw new Error('命令为空')
        const cwd = await inWorkspace(params.cwd ?? '.', true)
        const timeout = Math.min(
          MAX_EXEC_TIMEOUT_MS,
          Math.max(1000, Number(params.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS)),
        )
        return runScrubbed(command, cwd, timeout, workspaceRoot)
      }

      case 'storage.get': {
        const store = await readStore(storageRoot, pluginId)
        const key = requireKey(params.key)
        return { key, value: key in store ? store[key] : null, exists: key in store }
      }

      case 'storage.set': {
        const store = await readStore(storageRoot, pluginId)
        const key = requireKey(params.key)
        store[key] = params.value ?? null
        const serialized = `${JSON.stringify(store, null, 2)}\n`
        if (Buffer.byteLength(serialized, 'utf8') > MAX_STORAGE_BYTES) {
          throw new Error(
            `插件私有存储超出上限（${MAX_STORAGE_BYTES} 字节）。存大块内容请写工作区文件。`,
          )
        }
        await writeStore(storageRoot, pluginId, serialized)
        return { key, saved: true }
      }

      case 'storage.delete': {
        const store = await readStore(storageRoot, pluginId)
        const key = requireKey(params.key)
        const existed = key in store
        delete store[key]
        await writeStore(storageRoot, pluginId, `${JSON.stringify(store, null, 2)}\n`)
        return { key, deleted: existed }
      }

      case 'storage.list':
        return { keys: Object.keys(await readStore(storageRoot, pluginId)) }

      default:
        // 走到这里说明 requiredPermission() 认了这个前缀但没人实现。
        // **明确抛出**而不是返回 null——返回 null 在插件侧是一次成功但空结果的调用。
        throw new Error(`宿主能力尚未实现：${method}`)
    }
  }
}

/**
 * 跑一条命令，**不透传宿主环境变量**。
 *
 * 与 `run_command` 内置工具的关键差别就是这一点。那个工具跑的是用户自己批准的命令，
 * 看得到自己的环境天经地义；这里跑的是插件给的命令，而插件进程的 env 是被特意
 * 洗过的。透传等于把刚锁上的门从里面打开。
 *
 * 走 `spawnGuarded` 而不是自己 `Bun.spawn`：起子进程的地方**必须只有一处**。
 * 两处的代价不是重复代码，是加沙箱时漏掉一处不会报错——那一处只是安静地没有边界。
 * 插件这条路比 `run_command` 更需要沙箱：命令是第三方代码构造的，
 * 连「用户看过一眼」这个前提都没有。
 */
async function runScrubbed(
  command: string,
  cwd: string,
  timeoutMs: number,
  workspaceRoot: string,
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  const isWindows = process.platform === 'win32'

  const { proc } = await spawnGuarded({
    command,
    cwd,
    policy: { workspaceRoot, readOnlySubdirs: PROTECTED_DIRS },
    env: {
      PATH: process.env.PATH ?? '',
      ...(isWindows
        ? { SYSTEMROOT: process.env.SYSTEMROOT ?? '', TEMP: process.env.TEMP ?? '' }
        : { HOME: '/nonexistent' }),
      CI: '1',
      NO_COLOR: '1',
      TERM: 'dumb',
    },
  })

  // 等待与收尾走同一个收口：完成判据是进程退出而不是管道 EOF，超时走**树杀**。
  // 这里 spawn 出来的是一个 shell，只 kill 它自己的话，真正执行的那个仍在运行。
  const got = await collectProcess(proc, { timeoutMs, maxChars: MAX_EXEC_OUTPUT })
  return {
    exitCode: got.exitCode,
    stdout: capped(got.stdout),
    stderr: capped(got.stderr),
    timedOut: got.timedOut,
  }
}

/**
 * 到界了就说一声。
 *
 * 真正的「读到上限就停」在 `collectProcess` 里——**上限是读取行为的上限，不是
 * 返回值的上限**：读完再截的话，一条 `yes` 能在截断生效之前把内存吃光。
 * 这里只负责把「这一页不是全部」告诉插件。
 */
function capped(text: string): string {
  if (text.length < MAX_EXEC_OUTPUT) return text
  return `${text.slice(0, MAX_EXEC_OUTPUT)}\n…（输出超过 ${MAX_EXEC_OUTPUT} 字符，已截断）`
}

// ───────────────────────── 插件私有存储 ─────────────────────────

/**
 * 一个插件一个 JSON 文件。
 *
 * 不放 SQLite：插件存的是配置和小状态，为它开一张表要处理迁移、并发、连接生命周期，
 * 而 JSON 文件用户能直接看、直接删——插件行为异常时这一点比性能重要得多。
 */
function storePath(storageRoot: string, pluginId: string): string {
  // id 在 manifest 解析期已经限死为 `[a-z0-9][a-z0-9._-]{2,63}`，
  // 这里再滤一遍：存储路径是文件系统写入点，不能依赖上游校验没被绕过。
  const safe = pluginId.replace(/[^a-z0-9._-]/gi, '_')
  if (!safe || safe.startsWith('.')) throw new Error(`非法插件 id：${pluginId}`)
  return join(storageRoot, `${safe}.json`)
}

async function readStore(storageRoot: string, pluginId: string): Promise<Record<string, unknown>> {
  const raw = await readFile(storePath(storageRoot, pluginId), 'utf8').catch(() => null)
  if (raw === null) return {}
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    // 存储坏了不该让插件起不来。当作空的继续——插件会重新写它需要的键。
    return {}
  }
}

async function writeStore(storageRoot: string, pluginId: string, content: string): Promise<void> {
  const path = storePath(storageRoot, pluginId)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
}

function requireKey(raw: unknown): string {
  const key = String(raw ?? '').trim()
  if (!key) throw new Error('缺少 key')
  return key
}
