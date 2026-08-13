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
 * ## 为什么是模块级的一份，不是每页一份
 *
 * 三个设置页改的是**同一个** `~/.qywork/config.json`。上一版每页各自
 * `createResource(loadServerConfig)` + 各自一份草稿，于是切类目组件一卸载，
 * 没保存的改动就没了——最坏的一格是 API Key，password 框永远显示为空，
 * 丢没丢从界面上根本看不出来，用户以为存了，下一次调模型才炸。
 *
 * 一份共享的状态让这个问题在结构上消失，顺带也不用每次切页重发一次 GET。
 *
 * ## 为什么没有「保存」按钮了
 *
 * 改一格就写一次，和主题、LAN 开关、审批模式对齐——那三个本来就是即时生效的，
 * 而思考强度、路径清单要滚到底点保存。**同一个设置面里两种生效模型并存**，
 * 用户没法预测哪个控件属于哪种，这是上一版最本质的毛病。
 *
 * 不新增写路径：`setPermissionMode` 早就是「读全量 → 改一格 → 整份 PUT」，
 * 走的同一条 `/api/config`。即时生效不需要新接口，真源数不变。
 *
 * ## 乐观更新 + 失败回滚
 *
 * `patch` 先把新值写进本地信号（控件立刻反映用户的操作），再发 PUT。
 * 失败就重新拉服务端那份盖回来——**权威始终是服务端**，本地这份只是它的回声。
 * 不这么做的话，一次 422 之后界面显示的是一个从未落盘的值，
 * 而用户以为它生效了。
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
export const configError = error
export const configWriteError = writeError
export const configBusy = busy

/** 第一次有页面要用它时才拉。重复调用无副作用。 */
export function ensureConfig(): void {
  if (started) return
  started = true
  void reloadConfig()
}

export async function reloadConfig(): Promise<void> {
  try {
    setPayload(await loadServerConfig())
    setError(null)
  } catch (e) {
    setError(e)
  }
}

/**
 * 改一格并立刻落盘。
 *
 * `patch` 是**顶层字段**的浅合并。要同时动两个字段（比如删接口顺带改 active）
 * 的场景用 `replaceConfig`——分两次 patch 会让中间那一刻的配置不自洽，
 * 而每一次 patch 都会真的写盘。
 */
export function patchConfig(p: Partial<RedactedConfig>): Promise<void> {
  const base = config()
  if (!base) return Promise.resolve()
  return replaceConfig({ ...base, ...p })
}

export async function replaceConfig(next: RedactedConfig): Promise<void> {
  const prev = payload()
  if (!prev) return
  // 乐观：控件先反映用户的操作，不然点一下要等一个来回才动。
  setPayload({ ...prev, config: next })
  setBusy(true)
  try {
    setPayload(await saveServerConfig(next))
    setWriteError(null)
  } catch (e) {
    // 失败必须回滚到服务端真值，否则界面显示的是一个从未落盘的值。
    setWriteError(explainApiError(e, '保存失败'))
    await reloadConfig()
  } finally {
    setBusy(false)
  }
}
