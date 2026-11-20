/**
 * 接口或型号的协议、地址改变时的连带修改。设置页修改接口（`ModelSettings`）与拉取刷新型号协议（`pulled.ts`）共用。
 *
 * - 协议改变时，模型库覆盖中该型号的对应型号（`base`）复制到新协议的键下：覆盖按「型号 × 协议」索引，不复制时
 *   自定义名称的型号失去对应型号，窗口、单价与档位按未收录型号计算。只复制对应型号，其余覆盖字段是该型号在原协议上的规格。
 *   原键不删除：模型库覆盖与接口无关，其他接口可能仍以原协议使用该型号。
 * - 协议或地址改变时，删除该型号检测得到的思考参数结论（`transport` 的 effort、effortLevels、thinking）：结论属于检测时的
 *   端点与协议，保留时推理等级在新端点上仍按旧结论隐藏或限制。工具调用的检测记录带检测条件，由界面判定是否过期，不删除。
 */

import type { RedactedConfig, RedactedModel, RedactedProvider } from '../../lib/store/index.ts'

/** 一个型号的协议改变：`from` 与 `to` 是改变前后实际使用的协议。 */
export interface KindMove {
  id: string
  from: string
  to: string
}

/** 把对应型号复制到新协议的键下；新键已有对应型号时不覆盖。没有需要复制的条目时原样返回。 */
export function carryBase(
  catalog: RedactedConfig['catalog'],
  moves: readonly KindMove[],
): RedactedConfig['catalog'] {
  let next = catalog
  for (const { id, from, to } of moves) {
    if (from === to) continue
    const base = catalog?.[`${id}|${from}`]?.base
    const key = `${id}|${to}`
    if (base === undefined || next?.[key]?.base !== undefined) continue
    next = { ...next, [key]: { ...next?.[key], base } }
  }
  return next
}

/** 删除型号的思考参数检测结论，保留工具调用的检测记录。 */
export function withoutCalibration(model: RedactedModel): RedactedModel {
  if (!model.transport) return model
  const { effort: _effort, effortLevels: _levels, thinking: _thinking, ...kept } = model.transport
  const { transport: _transport, ...rest } = model
  return Object.keys(kept).length ? { ...rest, transport: kept } : rest
}

/** 修改接口的字段，并按上述规则修改其型号的检测结论与模型库覆盖。接口不存在时返回 null。 */
export function withProviderPatch(
  cur: RedactedConfig,
  name: string,
  patch: Partial<RedactedProvider>,
): RedactedConfig | null {
  const prev = cur.providers[name]
  if (!prev) return null
  const next: RedactedProvider = { ...prev, ...patch }
  const kindChanged = next.kind !== prev.kind
  const urlChanged = (next.baseUrl ?? '') !== (prev.baseUrl ?? '')
  // 单独声明了协议的型号不随接口的协议改变。
  const follows = (m: RedactedModel) => !m.kind
  if (kindChanged || urlChanged) {
    next.models = Object.fromEntries(
      Object.entries(prev.models).map(([id, m]) => [
        id,
        urlChanged || follows(m) ? withoutCalibration(m) : m,
      ]),
    )
  }
  const catalog = kindChanged
    ? carryBase(
        cur.catalog,
        Object.entries(prev.models)
          .filter(([, m]) => follows(m))
          .map(([id]) => ({ id, from: prev.kind, to: next.kind })),
      )
    : cur.catalog
  return {
    ...cur,
    providers: { ...cur.providers, [name]: next },
    ...(catalog ? { catalog } : {}),
  }
}
