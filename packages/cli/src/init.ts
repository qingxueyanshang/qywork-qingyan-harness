/**
 * `qy init`：为全新用户的首次运行生成配置。
 *
 * 没有该命令时，缺少配置的首次运行只会得到 provider 返回的 `auth_failed`，
 * 该消息不指向「配置文件尚未创建」这一真实原因。
 *
 * 此处有意不实现「检测到环境变量中有 key 即直接使用」：配置是用户可查看、
 * 可修改、可删除的 JSON 文件，推测生成的配置更难排查。init 只做一件事：
 * 把用户的回答写入该文件，然后输出路径。
 */

import { existsSync } from 'node:fs'
import type { QyConfig, StoredProvider } from '@qywork/runtime'
import { configPath, loadConfig, saveConfig } from '@qywork/runtime'

interface Preset {
  key: string
  label: string
  provider: StoredProvider
  /** 预置的模型。一个接口下可以配置多个模型，init 只负责使第一个模型可以运行。 */
  model: string
  /** 获取 key 的页面地址。直接写入链接，用户无需另行搜索。 */
  keyUrl: string
}

const PRESETS: Preset[] = [
  {
    key: 'anthropic',
    label: 'Anthropic（Claude）',
    provider: { kind: 'anthropic_messages', models: {} },
    model: 'claude-opus-5',
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    key: 'deepseek',
    label: 'DeepSeek',
    provider: {
      kind: 'openai_chat_completions',
      baseUrl: 'https://api.deepseek.com/v1',
      models: {},
    },
    model: 'deepseek-flash',
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    key: 'openai',
    label: 'OpenAI 或任意 OpenAI 兼容中转站',
    provider: {
      kind: 'openai_chat_completions',
      baseUrl: 'https://api.openai.com/v1',
      models: {},
    },
    model: 'gpt-5',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    key: 'local',
    label: '本机模型服务（ollama / LM Studio / vLLM）',
    provider: {
      kind: 'openai_chat_completions',
      baseUrl: 'http://127.0.0.1:11434/v1',
      models: {},
    },
    model: 'qwen3-coder',
    keyUrl: '',
  },
]

const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

export async function runInit(args: string[]): Promise<number> {
  const force = args.includes('--force')

  if (existsSync(configPath()) && !force) {
    process.stderr.write(
      `配置文件已存在：${configPath()}\n` +
        `  qy config       查看当前配置\n` +
        `  qy init --force 覆盖已有配置\n`,
    )
    return 1
  }

  // 非交互环境（CI、管道、Docker build）中无人应答。不阻塞、不推测，
  // 把可直接修改的模板输出到 stdout，供脚本重定向到配置文件。
  if (!process.stdin.isTTY) {
    process.stderr.write(`[qy] 非交互环境，输出配置模板（写入 ${configPath()} 后填入 key）：\n`)
    process.stdout.write(`${JSON.stringify(templateConfig(), null, 2)}\n`)
    return 0
  }

  process.stderr.write(`\n${BOLD}qywork 初始化${RESET}\n配置将写入 ${configPath()}\n\n`)
  for (const [i, p] of PRESETS.entries()) process.stderr.write(`  ${i + 1}. ${p.label}\n`)
  process.stderr.write(`\n请选择 [1-${PRESETS.length}，默认 1] `)

  const pick = Number((await readLine()).trim() || '1')
  const preset = PRESETS[pick - 1]
  if (!preset) {
    process.stderr.write(`无效的序号：${pick}\n`)
    return 2
  }

  const provider: StoredProvider = { ...preset.provider, models: {} }

  let modelId = preset.model
  process.stderr.write(`\n模型 [${modelId}]：`)
  const typed = (await readLine()).trim()
  if (typed) modelId = typed
  /*
   * 该模型的规格**留空**。
   *
   * **不要填入预置值**（例如 `maxOutputTokens: 8192`）：DeepSeek 的实际上限是
   * 384000（见 `catalog.ts`），相差 47 倍。
   *
   * 该值是硬上限：装配时与目录值取较小者（`agent/loop/request.ts` 的输出上限计算），每次请求都使用它。
   * 实测形状：DeepSeek 开启 max 思考档时，一轮思考占用 8493 token，预算在正文开始前耗尽，
   * run 以 `output_truncated` 结束。
   *
   * 目录值由本仓库实测维护，init 没有理由覆盖它。确需压低上限的
   * 用户可自行在配置中填写。
   */
  provider.models[modelId] = {}

  if (provider.baseUrl) {
    process.stderr.write(`接口地址 [${provider.baseUrl}]：`)
    const url = (await readLine()).trim()
    if (url) provider.baseUrl = url
  }

  // 本机服务无需 key，不显示无需填写的输入框。
  if (preset.key !== 'local') {
    if (preset.keyUrl) process.stderr.write(`\n${DIM}获取 key：${preset.keyUrl}${RESET}\n`)
    process.stderr.write('API Key（按回车跳过，之后可在设置页填写）：')
    const key = (await readLine()).trim()
    if (key) provider.apiKey = key
  }

  const existing = existsSync(configPath()) ? await loadConfig() : null
  const cfg: QyConfig = {
    active: { provider: preset.key, model: modelId },
    // --force 重新生成时保留用户已有的其他接口：用户要更换的是当前使用的接口，
    // 而不是删除之前配置的全部接口。
    providers: { ...(existing?.providers ?? {}), [preset.key]: provider },
    // 默认 auto：不弹出确认框，由硬边界与静态规则裁决。
    // 需要完全放开时由用户自行写入 "mode": "full"，该决定不应由 init 代替用户作出。
    mode: existing?.mode ?? 'auto',
  }
  await saveConfig(cfg)

  process.stderr.write(`\n${BOLD}已写入${RESET} ${configPath()}\n`)
  if (!provider.apiKey && preset.key !== 'local') {
    process.stderr.write(
      `${DIM}尚未填写 key：在配置文件中添加 "apiKey"，或在设置页填写。${RESET}\n`,
    )
  } else {
    process.stderr.write(`${DIM}示例：qy exec "介绍这个目录里的代码"${RESET}\n`)
  }
  return 0
}

function templateConfig(): QyConfig {
  const preset = PRESETS[0]!
  return {
    active: { provider: preset.key, model: preset.model },
    providers: {
      [preset.key]: {
        ...preset.provider,
        apiKey: 'sk-你的key',
        models: { [preset.model]: {} },
      },
    },
    mode: 'auto',
  }
}

async function readLine(): Promise<string> {
  for await (const line of console) return line
  return ''
}
