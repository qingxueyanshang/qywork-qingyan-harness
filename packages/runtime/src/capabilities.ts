/**
 * 宿主能力实现：插件通过 RPC 可执行的全部操作。
 *
 * 插件进程本身没有 `fs`、`net` 与 `child_process`（见 `plugins/host.ts`），
 * 任何操作都必须经由此处。因此本文件同时是功能面与攻击面：
 * 每增加一个方法，就为不受信任的第三方代码增加一个入口。
 *
 * 三层检查，缺一不可：
 *
 * 1. 权限（`plugins/loader.ts` → `checkPermission`）：manifest 未声明即拒绝。
 * 2. 边界（本文件）：声明 `workspace:read` 不等于能读取 `../../.ssh/id_rsa`；
 *    声明 `network` 不等于能访问 `http://169.254.169.254/`。
 * 3. 配额（本文件）：不限量的文件读取与命令输出都能耗尽宿主资源，
 *    插件无需恶意代码，一个缺陷即可触发。
 *
 * 容易遗漏的一项是 exec 的环境变量。`run_command` 内置工具把 `process.env` 完整透传给子进程：
 * 那是用户自己的命令，应当看到自身的环境。插件的 exec 不能这样做：宿主专门清理了插件进程的
 * env（不提供 API Key 与令牌），若插件能经由 `exec.run` 执行 `echo $ANTHROPIC_API_KEY`，
 * 这层清理即失效。
 */

import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { HostCallContext } from '@qywork/plugins'
import {
  collectProcess,
  commandShell,
  displayPath,
  PROTECTED_DIRS,
  resolveInWorkspace,
  type SafetyOptions,
  safeFetch,
  spawnGuarded,
} from '@qywork/tools'

/** 单次 fs.read 的上限。插件不应用它读取大文件，大文件由 read_resource 处理。 */
const MAX_READ_BYTES = 4 * 1024 * 1024
/** 单次 fs.write 的上限。 */
const MAX_WRITE_BYTES = 8 * 1024 * 1024
/** exec 的输出上限，stdout 与 stderr 分别计算。 */
const MAX_EXEC_OUTPUT = 512 * 1024
const DEFAULT_EXEC_TIMEOUT_MS = 30_000
const MAX_EXEC_TIMEOUT_MS = 300_000
/** 单个插件的私有存储上限。KV 不是数据库，超出上限说明用法有误。 */
const MAX_STORAGE_BYTES = 2 * 1024 * 1024
/** fs.list 单次返回的条目上限。 */
const MAX_LIST_ENTRIES = 2000

export const PLUGIN_DATA_DIR = '.qy/plugin-data'

export interface CapabilityOptions {
  workspaceRoot: string
  /** 插件私有存储根。默认 `<workspaceRoot>/.qy/plugin-data`。 */
  storageRoot?: string
  /** 网络访问策略，与 web_fetch 共用同一套 SSRF 防护。 */
  netPolicy?: SafetyOptions
}

export type CapabilityHandler = (
  method: string,
  params: Record<string, unknown>,
  context: HostCallContext,
) => Promise<unknown>

/**
 * 已登记的方法清单。
 *
 * 唯一的消费者是回归测试：测试逐条调用，断言没有任何方法进入 default 分支的
 * 「尚未实现」。清单与 switch 因此保持一致：新增方法未登记会使测试失败，
 * 已登记但未实现同样失败。`docs/plugins.md` 中的表格依据本清单编写。
 *
 * 有意不放入握手的能力声明：该字段目前没有客户端读取，
 * 增加无消费者的协议成员会形成一条未接通的链路。
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

  return async (method, params, context) => {
    const pluginId = context.pluginId
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
        // base64 用于二进制内容。默认 utf8：绝大多数插件读取的是文本，
        // 由插件每次自行解码会多出一次无用的转换。
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
        // 截断必须明确告知。静默截断会使插件把当前一页当作整个目录，
        // 其「已处理全部文件」的结论因此错误。
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
        // 不提供 recursive：误删整棵目录树与误删一个文件的后果相差数个量级，
        // 而插件几乎没有正当理由需要前者。
        const info = await stat(path)
        if (info.isDirectory()) {
          throw new Error(`拒绝删除目录（只允许删除文件）：${displayPath(workspaceRoot, path)}`)
        }
        await rm(path)
        return { deleted: displayPath(workspaceRoot, path) }
      }

      case 'net.fetch': {
        const url = String(params.url ?? '')
        if (!url) throw new Error('缺少 url')
        // 与 web_fetch 使用同一套 SSRF 防护：每次重定向重新校验，按解析后的 IP 分类。
        // 插件路径更需要这层防护：URL 完全由第三方代码构造。
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
          truncated: res.truncated,
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
            `插件私有存储超出上限（${MAX_STORAGE_BYTES} 字节）。大体量内容请写入工作区文件。`,
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
        // 执行到此处说明 requiredPermission() 接受了该前缀，但没有对应实现。
        // 明确抛错而不是返回 null：返回 null 在插件侧表现为一次成功但结果为空的调用。
        throw new Error(`宿主能力尚未实现：${method}`)
    }
  }
}

/**
 * 运行一条命令，不透传宿主环境变量。
 *
 * 与 `run_command` 内置工具的关键差别在于此。该工具运行的是用户自己批准的命令，
 * 看到自身的环境是合理的；这里运行的是插件提供的命令，而插件进程的 env 经过专门
 * 清理。透传会使这层清理失效。
 *
 * 使用 `spawnGuarded` 而不是直接调用 `Bun.spawn`：启动子进程的位置必须只有一处。
 * 存在两处时，问题不在于重复代码，而在于增加沙箱时遗漏一处不会报错，该处只是无提示地缺少边界。
 * 插件路径比 `run_command` 更需要沙箱：命令由第三方代码构造，
 * 用户没有查看过。
 */
async function runScrubbed(
  command: string,
  cwd: string,
  timeoutMs: number,
  workspaceRoot: string,
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  const isWindows = process.platform === 'win32'

  const { proc } = await spawnGuarded({
    shell: commandShell(),
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

  // 等待与收尾均由 `collectProcess` 处理：完成判据是进程退出而不是管道 EOF，超时时终止整个进程树。
  // 此处启动的是一个 shell，只终止 shell 本身时，实际执行命令的进程仍在运行。
  const got = await collectProcess(proc, { timeoutMs, maxChars: MAX_EXEC_OUTPUT })
  return {
    exitCode: got.exitCode,
    stdout: capped(got.stdout),
    stderr: capped(got.stderr),
    timedOut: got.timedOut,
  }
}

/**
 * 达到上限时告知插件。
 *
 * 读取到上限即停止的逻辑在 `collectProcess` 中：上限约束的是读取行为，不是
 * 返回值；全部读取后再截断时，一条 `yes` 命令会在截断生效之前耗尽内存。
 * 本函数只负责告知插件当前内容不完整。
 */
function capped(text: string): string {
  if (text.length < MAX_EXEC_OUTPUT) return text
  return `${text.slice(0, MAX_EXEC_OUTPUT)}\n…（输出超过 ${MAX_EXEC_OUTPUT} 字符，已截断）`
}

// ───────────────────────── 插件私有存储 ─────────────────────────

/**
 * 每个插件一个 JSON 文件。
 *
 * 不使用 SQLite：插件存储的是配置与少量状态，为其建表需要处理迁移、并发与连接生命周期，
 * 而 JSON 文件可由用户直接查看和删除；插件行为异常时，这一点比性能重要得多。
 */
function storePath(storageRoot: string, pluginId: string): string {
  // id 在 manifest 解析阶段已限定为 `[a-z0-9][a-z0-9._-]{2,63}`，
  // 此处再过滤一次：存储路径是文件系统写入点，不能假定上游校验未被绕过。
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
    // 存储损坏时不应导致插件无法启动。按空存储继续：插件会重新写入它需要的键。
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
