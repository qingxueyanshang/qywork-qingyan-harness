/**
 * `qy probe` —— 实测一个供应商档案到底支持什么。
 *
 * 内置目录只认得出自己认识的模型；接中转站、自建网关、刚发布的模型时，
 * 它回落到一组保守的猜测。保守是对的，但**没有任何办法验证那个猜测**——
 * 结果是：支持思考的端点从不开思考，不支持的又每次都 400，只能靠人试。
 *
 *   qy probe                  探当前生效的那个模型
 *   qy probe <模型名>         探指定模型（走它所属的接口）
 *   qy probe --save           把结果写回配置（不加这个只打印，不改任何东西）
 *
 * 探测会**真的发几个请求**（每个一个字、最多 16 token），所以它只由用户显式触发。
 */

import { describeProbe, probeModel, toCapabilities } from '@qywork/ai'
import { catalogKey, loadConfig, resolveModel, saveConfig } from '@qywork/runtime'

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
    // **不带模型库里那条覆盖**：带上等于让上一次的探测结果影响这一次，
    // 探出来的就不再是端点的事实，而是「上次那个结论有没有自洽」。
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

  const caps = toCapabilities(outcome)

  // 探不出来的轴要**点名**说，不能笼统一句「没结论」。
  // OpenAI 兼容协议下本客户端根本不发 thinking / effort，那些轴无从探测；
  // 但「省略字段时它自己思不思考」是从回包看出来的，那一条永远有结论。
  // 报成失败会让用户去查一个没坏的东西。
  if (outcome.untested.length) {
    process.stderr.write(
      `\n${DIM}未探测的轴：${outcome.untested.join(' / ')}（本协议下客户端不发这些字段），` +
        `目录里的保守默认值保持不变。${RESET}\n`,
    )
  }

  if (!save) {
    // 默认不改配置。探测会改变后续每一次请求的形状，那种事不该在用户只想
    // 「看一眼」的时候发生。
    process.stderr.write(`\n${DIM}加 --save 把这份结论写回配置${RESET}\n`)
    return 0
  }

  // 落进模型库那一格：探的是「这条模型在这条协议上」的行为，键的两维正好是它。
  // 协议从当前接口取，不从模型名猜。
  const key = catalogKey(stored.model, stored.kind)
  config.catalog = { ...config.catalog, [key]: { ...config.catalog?.[key], ...caps } }
  await saveConfig(config)
  process.stderr.write(`\n已写回模型库 ${key} 的能力：${Object.keys(caps).join('、')}\n`)
  return 0
}
