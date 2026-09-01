/**
 * `qy probe` —— 实测一个供应商档案支持什么。
 *
 * 内置目录只认得出自己认识的模型；接中转站、自建网关、刚发布的模型时，
 * 它回落到一组保守的猜测。保守是对的，但**没有任何办法验证那个猜测**——
 * 结果是：支持思考的端点从不开思考，不支持的又每次都 400，只能靠人试。
 *
 *   qy probe                  探当前生效的那个模型
 *   qy probe <模型名>         探指定模型（走它所属的接口）
 *   qy probe --save           把结果写回配置（不加这个只打印，不改配置）
 *
 * 探测会**真的发几个请求**（每个一个字、最多 16 token），所以它只由用户显式触发。
 */

import { describeProbe, probeModel, toTransportCapabilities } from '@qywork/ai'
import { loadConfig, resolveModel, saveConfig } from '@qywork/runtime'

const DIM = '\x1b[2m'
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'

export async function runProbe(args: string[]): Promise<number> {
  const save = args.includes('--save')
  const json = args.includes('--json')
  const name = args.find((a) => !a.startsWith('-'))

  const config = await loadConfig()
  const stored = resolveModel(config, name)
  if (!stored) {
    const known = Object.keys(config.providers).join('、') || '（空）'
    process.stderr.write(`配置里没有名为 "${config.active.provider}" 的接口。已有：${known}\n`)
    return 2
  }

  process.stderr.write(
    `${BOLD}探测 ${stored.provider} / ${stored.model}${RESET} ${DIM}${stored.kind}${RESET}\n` +
      `${DIM}会发几个极小的请求（每个 ≤16 token）${RESET}\n\n`,
  )

  const outcome = await probeModel({
    kind: stored.kind,
    apiKey: stored.apiKey ?? '',
    model: stored.model,
    ...(stored.baseUrl ? { baseUrl: stored.baseUrl } : {}),
    ...(stored.headers ? { headers: stored.headers } : {}),
    // 不带上次的 transport 结论：否则被判定为不透传后，下一次探测自己也不再发
    // effort，探出来的只会是「上次那个结论有没有自洽」。
  })

  if (json) {
    process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`)
  } else {
    process.stdout.write(`${describeProbe(outcome, stored.kind, stored.model)}\n`)
  }

  if (!outcome.reachable) {
    process.stderr.write(`\n${DIM}端点不通。先确认 key、模型名和接口地址。${RESET}\n`)
    return 1
  }

  const transport = toTransportCapabilities(outcome)

  // 探不出来的轴要**点名**说，不能笼统一句「没结论」。
  // 模型的思考参数格式发不出 effort 时那一轴无从探测；但「什么都不发时它自己思不思考」
  // 是从回包看出来的，那一条永远有结论。报成失败会让用户去查一处没坏的配置。
  if (outcome.untested.length) {
    process.stderr.write(
      `\n${DIM}未探测的轴：${outcome.untested.join(' / ')}（这条链路不发该字段），` +
        `目录里的保守默认值保持不变。${RESET}\n`,
    )
  }
  if (outcome.inconclusive.length) {
    process.stderr.write(
      `\n${DIM}未得出结论的轴：${outcome.inconclusive.join(' / ')}（请求超时、限速或上游暂不可用），` +
        `配置保持不变。${RESET}\n`,
    )
  }

  if (!save) {
    // 默认不改配置。探测会改变后续每一次请求的形状，那种事不该在用户只想
    // 「看一眼」的时候发生。
    process.stderr.write(`\n${DIM}加 --save 把这份结论写回配置${RESET}\n`)
    return 0
  }

  // 只写当前接口下的模型格子。模型档位来自官方目录；探测回答的是这个具体端点
  // 是否透传控制面，不能写进 model + protocol 的全局目录污染其他中转。
  const owner = config.providers[stored.provider]
  const model = owner?.models[stored.model]
  if (!owner || !model) return 2
  if (Object.keys(transport).length === 0) {
    process.stderr.write(`\n没有可写的传输结论，配置保持不变。\n`)
    return 0
  }

  owner.models[stored.model] = {
    ...model,
    transport: { ...model.transport, ...transport },
  }
  await saveConfig(config)
  process.stderr.write(
    `\n已写回接口 ${stored.provider} / ${stored.model} 的传输校准：` +
      `${Object.keys(transport).join('、')}\n`,
  )
  return 0
}
