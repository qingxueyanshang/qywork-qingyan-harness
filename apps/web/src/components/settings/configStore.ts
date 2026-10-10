import { createSignal } from 'solid-js'
import {
  type ConfigPayload,
  explainApiError,
  loadServerConfig,
  type ProviderRename,
  type RedactedConfig,
  saveServerConfig,
} from '../../lib/store/index.ts'

/**
 * 设置页共用的服务端配置。
 *
 * 采用模块级的一份而不是每页一份：多个设置页修改的是同一个 `~/.qywork/config.json`。若每页
 * 各自调用 `createResource(loadServerConfig)` 并持有一份草稿，切换类目导致组件卸载时，未保存的修改随之丢失。
 * 影响最大的是 API Key：password 输入框始终显示为空，界面无法反映是否丢失，保存显示成功，直到下一次
 * 调用模型才失败。
 *
 * 共享状态从结构上消除了该问题，且切换页面时无需重新发送 GET。
 *
 * 不设「保存」按钮：每修改一个字段即写入一次，与主题、LAN 开关、审批模式的即时生效方式一致。
 * 同一设置界面中并存两种生效方式时，用户无法预测各控件属于哪一种。
 *
 * 不新增写路径：`setPermissionMode` 同样是「读取完整配置 → 修改一个字段 → 整份 PUT」，
 * 使用同一个 `/api/config`。即时生效无需新接口，真源数不变。
 *
 * 乐观更新与失败回滚：`patch` 先把新值写入本地信号（控件立即反映用户的操作），再发送 PUT。
 * 失败时重新读取服务端配置并覆盖本地值：权威始终是服务端，本地状态只是它的投影。
 * 不回滚时，一次 422 之后界面显示的是从未落盘的值，
 * 且与已生效的值无法区分。
 */

const [payload, setPayload] = createSignal<ConfigPayload | null>(null)
const [error, setError] = createSignal<unknown>(null)
/** 最近一次写入失败的原因。写入成功即清空：它只描述最近一次写入。 */
const [writeError, setWriteError] = createSignal<string | null>(null)
const [busy, setBusy] = createSignal(false)

let started = false

export const config = () => payload()?.config ?? null
export const configPath = () => payload()?.path ?? ''
export const configNotices = () => payload()?.notices ?? []
export const configProblems = () => payload()?.problems ?? []
export const defaultEnvAllowList = () => payload()?.defaultEnvAllowList ?? []
export const configError = error
export const configWriteError = writeError
export const configBusy = busy

/**
 * 把一次本地校验失败显示在写入错误的同一位置（如添加已存在的模型 id）。
 * 不要由各控件各自渲染错误：失败提示只应有一处，下一次写入成功时自动清空。
 */
export function reportConfigWriteError(message: string): void {
  setWriteError(message)
}

/** 首次有页面使用时才请求。重复调用无副作用。 */
export function ensureConfig(): void {
  if (started) return
  started = true
  void reloadConfig()
}

export async function reloadConfig(): Promise<void> {
  try {
    publishConfig(await loadServerConfig())
    setError(null)
  } catch (e) {
    setError(e)
  }
}

/**
 * 修改顶层字段并立即落盘。
 *
 * `patch` 是顶层字段的浅合并。需要同时修改两个相关字段（例如删除接口并修改 active）时
 * 使用 `replaceConfig`：分两次 patch 会使中间状态的配置不一致，
 * 而每一次 patch 都会实际写入磁盘。
 */
export function patchConfig(p: Partial<RedactedConfig>): Promise<void> {
  return replaceConfig((cur) => ({ ...cur, ...p }))
}

/**
 * 配置写入串行队列，同一时刻仅执行一次。并发写入若不串行，后发起的一次会在前一次
 * 落盘前读到旧配置，整体回写时覆盖前一次已保存的字段（例如先后写入 API Key 与
 * Base URL 时丢失 Key）。串行化保证每次写入读到的均为前一次落盘后的结果；队列内
 * 单次失败不阻断后续写入。
 */
type ConfigEdit = (cur: RedactedConfig) => RedactedConfig | null
const writeQueue: { edit: ConfigEdit; renameProvider?: ProviderRename; resolve: () => void }[] = []

/** 在保存回执上叠加尚未完成的编辑，避免前一次回执使后一次操作短暂显示为旧值。 */
function publishConfig(fresh: ConfigPayload): void {
  const projected = writeQueue.reduce((cur, { edit }) => {
    try {
      return edit(cur) ?? cur
    } catch {
      // 最新配置可能已使后续编辑失效；该项轮到保存时统一报告错误，不阻断其余投影。
      return cur
    }
  }, fresh.config)
  setPayload({ ...fresh, config: projected })
}

/**
 * 修改配置。参数是编辑函数，而不是修改后的完整配置。
 *
 * 保存使用整份 PUT，写入文件的就是此处提交的完整配置。若传入计算好的结果，
 * 其计算基础固定为页面打开时读取的配置，期间 `qy probe`、
 * 手动编辑 JSON、其他实例写入文件的修改都会被这次保存整体覆盖。
 *
 * 传入编辑函数时，可以在写入前重新读取服务端真值，并在其上重新计算。
 * 返回 `null` 表示放弃本次写入（前提在新数据上不再成立）。
 */
export async function replaceConfig(
  edit: ConfigEdit,
  renameProvider?: ProviderRename,
): Promise<void> {
  const prev = payload()
  if (!prev) return
  let optimistic: RedactedConfig | null
  try {
    optimistic = edit(prev.config)
  } catch (e) {
    setWriteError(explainApiError(e, '保存失败'))
    return
  }
  if (!optimistic) return
  // 乐观更新立即执行，不进入队列：控件须立即反映操作。此时 payload 已包含前一次的乐观值，
  // 因此连续修改两个字段时叠加正确；需要串行的只有下方读取服务端配置与 PUT 的部分。
  setPayload({ ...prev, config: optimistic })
  return new Promise<void>((resolve) => {
    writeQueue.push({ edit, ...(renameProvider ? { renameProvider } : {}), resolve })
    if (!busy()) void flushWrites()
  })
}

async function flushWrites(): Promise<void> {
  setBusy(true)
  try {
    while (writeQueue.length) {
      const pending = writeQueue[0]!
      const fresh = await flushWrite(pending.edit, pending.renameProvider)
      writeQueue.shift()
      if (fresh) publishConfig(fresh)
      pending.resolve()
    }
  } finally {
    setBusy(false)
  }
}

/** 服务端以 409（配置已被其他客户端修改）拒绝保存：唯一携带 `status` 的错误。 */
function isConflict(e: unknown): boolean {
  return (
    typeof (e as { status?: unknown }).status === 'number' &&
    (e as { status: number }).status === 409
  )
}

async function flushWrite(
  edit: ConfigEdit,
  renameProvider?: ProviderRename,
): Promise<ConfigPayload | null> {
  try {
    // 409 表示配置已被其他客户端修改。重新读取完整配置、在其上重放本次编辑后再次提交；
    // 有界重试以避免两端反复冲突。同一客户端的写入已由队列串行，不会与自身冲突。
    for (let attempt = 0; ; attempt++) {
      const fresh = await loadServerConfig()
      const next = edit(fresh.config)
      if (!next) return fresh
      try {
        const saved = await saveServerConfig(next, fresh.version, renameProvider)
        setWriteError(null)
        return saved
      } catch (e) {
        if (isConflict(e) && attempt < 5) continue
        throw e
      }
    }
  } catch (e) {
    // 失败时必须回滚到服务端真值，否则界面显示从未落盘的值。
    setWriteError(explainApiError(e, '保存失败'))
    try {
      const fresh = await loadServerConfig()
      setError(null)
      return fresh
    } catch (reloadError) {
      setError(reloadError)
      return null
    }
  }
}
