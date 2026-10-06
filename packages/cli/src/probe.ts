/**
 * `qy probe`：经由模型所属接口实测该模型支持的能力。
 *
 * 内置目录只能识别已收录的模型；接入中转站、自建网关或新发布的模型时，
 * 它回退到一组保守的推测值。保守是正确的，但**没有任何办法验证这些推测**：
 * 支持思考的端点从不开启思考，不支持的端点每次都返回 400，只能人工尝试。
 *
 *   qy probe                  探测当前生效的模型
 *   qy probe <模型名>         探测指定模型（经由其所属接口）
 *   qy probe --save           把结果写回配置（不加该参数时只打印，不修改配置）
 *
 * 探测会发送连接、档位和两轮工具契约请求，因此只由用户显式触发。
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
    if (!name && !config.active) {
      process.stderr.write(
        `未配置模型。请为 qy probe 指定模型名，或先在设置中配置。已有接口：${known}\n`,
      )
      return 2
    }
    const target = name ?? config.active?.model
    process.stderr.write(
      `无法确定模型 "${target}" 所属的接口。请在设置中检查模型归属和默认接口。已有接口：${known}\n`,
    )
    return 2
  }

  process.stderr.write(
    `${BOLD}探测 ${stored.provider} / ${stored.model}${RESET} ${DIM}${stored.kind}${RESET}\n` +
      `${DIM}检测连接、思考档位和两轮工具调用${RESET}\n\n`,
  )

  const outcome = await probeModel({
    kind: stored.kind,
    apiKey: stored.apiKey ?? '',
    model: stored.model,
    ...(stored.baseUrl ? { baseUrl: stored.baseUrl } : {}),
    ...(stored.headers ? { headers: stored.headers } : {}),
    ...(stored.spec ? { spec: stored.spec } : {}),
    // 不带入上次的 transport 结论：否则某项被判定为不透传后，下一次探测本身也不再发送
    // effort，得到的只是上次结论的自洽性。
  })

  if (json) {
    process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`)
  } else {
    process.stdout.write(`${describeProbe(outcome, stored.kind, stored.model)}\n`)
  }

  if (!outcome.reachable) {
    process.stderr.write(`\n${DIM}端点无法连接。请先确认 key、模型名和接口地址。${RESET}\n`)
    return 1
  }

  const transport = toTransportCapabilities(outcome)

  // 参数校验未确认时保留配置；思考观察独立报告。
  if (outcome.untested.length) {
    process.stderr.write(
      `\n${DIM}未探测的项：${outcome.untested.join(' / ')}（该链路不发送这些字段），` +
        `目录中的保守默认值保持不变。${RESET}\n`,
    )
  }
  if (outcome.inconclusive.length) {
    process.stderr.write(
      `\n${DIM}未得出结论的项：${outcome.inconclusive.join(' / ')}（请求失败或接口未通过非法值对照），` +
        `配置保持不变。${RESET}\n`,
    )
  }

  if (!save) {
    // 默认不修改配置。探测结论会改变后续每一次请求的形状，不应在用户只需
    // 查看结论时生效。
    process.stderr.write(`\n${DIM}加 --save 将该结论写回配置${RESET}\n`)
    return 0
  }

  if (Object.keys(transport).length === 0) {
    process.stderr.write(`\n没有可写回的传输结论，配置保持不变。\n`)
    return 0
  }

  // 写回前重新读取配置，只修改该模型条目的 `transport`，不修改全局模型目录。
  // 不要把开始时读取的配置整份写回：探测耗时数十秒到数分钟，期间在设置页或其他进程中
  // 保存的修改会被整份覆盖。
  const latest = await loadConfig()
  const owner = latest.providers[stored.provider]
  const model = owner?.models[stored.model]
  if (!owner || !model) {
    process.stderr.write(
      `\n探测期间接口 ${stored.provider} / ${stored.model} 已从配置中移除，未写回。\n`,
    )
    return 2
  }
  owner.models[stored.model] = {
    ...model,
    transport: { ...model.transport, ...transport },
  }
  await saveConfig(latest)
  process.stderr.write(
    `\n已写回接口 ${stored.provider} / ${stored.model} 的传输校准：` +
      `${Object.keys(transport).join('、')}\n`,
  )
  return 0
}
