import { createSignal } from 'solid-js'
import {
  type ConfigPayload,
  explainApiError,
  loadServerConfig,
  type RedactedConfig,
  saveServerConfig,
} from '../../lib/store/index.ts'

/**
 * 设置页共用的那一份服务端配置。
 *
 * **为什么是模块级的一份，不是每页一份。** 三个设置页改的是**同一个** `~/.qywork/config.json`。每页
 * 各自 `createResource(loadServerConfig)` + 各自一份草稿的话，切类目组件一卸载，没保存的改动就没了
 * ——最坏的一格是 API Key，password 框永远显示为空，丢没丢从界面上看不出来，保存显示成功，下一次
 * 调模型才失败。
 *
 * 一份共享的状态让这个问题在结构上消失，也不用每次切页重发一次 GET。
 *
 * **为什么没有「保存」按钮了。** 改一格就写一次，和主题、LAN 开关、审批模式对齐——那三个本来就是即
 * 时生效的，而思考强度、路径清单要滚到底点保存。**同一个设置面里两种生效模型并存**的话，用户没法
 * 预测哪个控件属于哪种。
 *
 * 不新增写路径：`setPermissionMode` 早就是「读全量 → 改一格 → 整份 PUT」，
 * 走的同一条 `/api/config`。即时生效不需要新接口，真源数不变。
 *
 * **乐观更新 + 失败回滚。** `patch` 先把新值写进本地信号（控件立刻反映用户的操作），再发 PUT。
 * 失败就重新拉服务端那份盖回来——**权威始终是服务端**，本地这份只是它的回声。
 * 不这么做的话，一次 422 之后界面显示的是一个从未落盘的值，
 * 而它在界面上与已生效的值无从区分。
 */

const [payload, setPayload] = createSignal<ConfigPayload | null>(null)
const [error, setError] = createSignal<unknown>(null)
/** 最近一次写失败的原因。写成功就清空——它描述的是「刚才那一下」。 */
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
 * 把一次**本地**校验失败显示到同一处写错误位（如添加了已存在的模型 id）。
 * 走这条而不是各控件自己画一行：失败提示只该有一处，下一次成功写入自动清空。
 */
export function reportConfigWriteError(message: string): void {
  setWriteError(message)
}

/** 第一次有页面要用它时才拉。重复调用无副作用。 */
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
 * 改一格并立刻落盘。
 *
 * `patch` 是**顶层字段**的浅合并。要同时动两个字段（比如删接口并改 active）
 * 的场景用 `replaceConfig`——分两次 patch 会让中间那一刻的配置不自洽，
 * 而每一次 patch 都会真的写盘。
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
const writeQueue: { edit: ConfigEdit; resolve: () => void }[] = []

/** 保存回执上仍叠加尚未完成的编辑，避免前一次回执把后一次操作闪回旧值。 */
function publishConfig(fresh: ConfigPayload): void {
  const projected = writeQueue.reduce((cur, { edit }) => edit(cur) ?? cur, fresh.config)
  setPayload({ ...fresh, config: projected })
}

/**
 * 改配置。**传的是改法，不是改完的那份。**
 *
 * 保存走整份 PUT，写进文件的就是这里交出去的整份。传一份算好的结果，
 * 那它算在什么之上就定死了——页面打开时拉的那一份。这中间 `qy probe`、
 * 手编 JSON、另一个实例往文件里写的改动，全会被这一次保存整份盖掉。
 *
 * 传改法就能在写之前重新拿一次服务端真值、在它之上再算一遍。
 * 返回 `null` 表示放弃这次写（前提在新数据上不再成立）。
 */
export async function replaceConfig(edit: ConfigEdit): Promise<void> {
  const prev = payload()
  if (!prev) return
  const optimistic = edit(prev.config)
  if (!optimistic) return
  // 乐观更新立即做，不进队列：控件要马上反映操作。此刻 payload 已含前一次的乐观值，
  // 所以连续改两格叠加正确；真正要串行的只是下面读服务端 + PUT 那一段。
  setPayload({ ...prev, config: optimistic })
  return new Promise<void>((resolve) => {
    writeQueue.push({ edit, resolve })
    if (!busy()) void flushWrites()
  })
}

async function flushWrites(): Promise<void> {
  setBusy(true)
  try {
    while (writeQueue.length) {
      const pending = writeQueue[0]!
      const fresh = await flushWrite(pending.edit)
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

async function flushWrite(edit: ConfigEdit): Promise<ConfigPayload | null> {
  try {
    // 409 表示配置已被其他客户端修改。重新读取完整配置、在其上重放本次编辑后再次提交；
    // 有界重试以避免两端反复冲突。同一客户端的写入已由队列串行，不会与自身冲突。
    for (let attempt = 0; ; attempt++) {
      const fresh = await loadServerConfig()
      const next = edit(fresh.config)
      try {
        const saved = next ? await saveServerConfig(next, fresh.version) : fresh
        setWriteError(null)
        return saved
      } catch (e) {
        if (isConflict(e) && attempt < 5) continue
        throw e
      }
    }
  } catch (e) {
    // 失败必须回滚到服务端真值，否则界面显示的是一个从未落盘的值。
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
