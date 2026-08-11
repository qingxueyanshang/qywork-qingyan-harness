/**
 * `qy init` —— 把「全新用户第一次运行」这条路径变成可走的。
 *
 * 之前它是这样的：装完 → `qy exec "..."` → `错误 [auth_failed] API Key 无效`。
 * 用户会去检查一个根本不存在的 key 抄错没抄错。真相是配置文件还没有。
 *
 * 这里刻意不做「自动探测环境变量里有没有 key 就悄悄用上」：配置是用户能看见、
 * 能改、能删的一个 JSON 文件，猜出来的配置反而更难排查。init 只做一件事——
 * 把用户的回答落成那个文件，然后把路径打出来。
 */

import { existsSync } from 'node:fs'
import type { QyConfig, StoredProfile } from '@qywork/runtime'
import { configPath, loadConfig, saveConfig } from '@qywork/runtime'

interface Preset {
  key: string
  label: string
  profile: StoredProfile
  /** 去哪儿领 key。写死链接比让用户自己搜要省事得多。 */
  keyUrl: string
}

const PRESETS: Preset[] = [
  {
    key: 'anthropic',
    label: 'Anthropic（Claude）',
    profile: { kind: 'anthropic', model: 'claude-opus-5', apiKeyEnv: 'ANTHROPIC_API_KEY' },
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    key: 'deepseek',
    label: 'DeepSeek',
    profile: {
      kind: 'openai_compatible',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      maxOutputTokens: 8192,
    },
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    key: 'openai',
    label: 'OpenAI 或任意 OpenAI 兼容中转站',
    profile: {
      kind: 'openai_compatible',
      model: 'gpt-5',
      baseUrl: 'https://api.openai.com/v1',
      apiKeyEnv: 'OPENAI_API_KEY',
    },
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    key: 'local',
    label: '本机模型服务（ollama / LM Studio / vLLM）',
    profile: {
      kind: 'openai_compatible',
      model: 'qwen3-coder',
      baseUrl: 'http://127.0.0.1:11434/v1',
    },
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
        `  qy init --force 覆盖重建\n`,
    )
    return 1
  }

  // 非交互环境（CI、管道、Docker build）里没人能回答。不阻塞、不猜，
  // 把一份能直接改的模板打到 stdout，让脚本可以重定向进配置文件。
  if (!process.stdin.isTTY) {
    process.stderr.write(`[qy] 非交互环境，输出配置模板（写入 ${configPath()} 后填入 key）：\n`)
    process.stdout.write(`${JSON.stringify(templateConfig(), null, 2)}\n`)
    return 0
  }

  process.stderr.write(`\n${BOLD}qywork 初始化${RESET}\n配置会写到 ${configPath()}\n\n`)
  for (const [i, p] of PRESETS.entries()) process.stderr.write(`  ${i + 1}. ${p.label}\n`)
  process.stderr.write(`\n选哪个？[1-${PRESETS.length}，默认 1] `)

  const pick = Number((await readLine()).trim() || '1')
  const preset = PRESETS[pick - 1]
  if (!preset) {
    process.stderr.write(`不是有效的序号：${pick}\n`)
    return 2
  }

  const profile: StoredProfile = { ...preset.profile }

  process.stderr.write(`\n模型 [${profile.model}]：`)
  const model = (await readLine()).trim()
  if (model) profile.model = model

  if (profile.baseUrl) {
    process.stderr.write(`接口地址 [${profile.baseUrl}]：`)
    const url = (await readLine()).trim()
    if (url) profile.baseUrl = url
  }

  // 本机服务不需要 key，别逼用户对着一个不需要填的输入框想「我是不是漏了什么」。
  if (preset.key !== 'local') {
    const fromEnv = profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined
    if (fromEnv) {
      process.stderr.write(
        `\n${DIM}检测到环境变量 ${profile.apiKeyEnv} 已设置，直接用它（配置文件里不存明文）。${RESET}\n`,
      )
    } else {
      if (preset.keyUrl) process.stderr.write(`\n${DIM}领 key：${preset.keyUrl}${RESET}\n`)
      process.stderr.write(`API Key（直接回车则跳过，之后设 ${profile.apiKeyEnv} 也行）：`)
      const key = (await readLine()).trim()
      if (key) profile.apiKey = key
    }
  }

  const existing = existsSync(configPath()) ? await loadConfig() : null
  const cfg: QyConfig = {
    active: preset.key,
    // --force 重建时保留用户已有的其它档案：他们要换的是当前用哪个，
    // 不是把之前配好的几家全删掉。
    profiles: { ...(existing?.profiles ?? {}), [preset.key]: profile },
    effort: existing?.effort ?? 'high',
    // 默认 auto：不弹窗，由硬边界 + 静态规则 + 分类器裁决。
    // 想完全放开要用户自己去写 "mode": "full"——那个决定不该由 init 替他做。
    mode: existing?.mode ?? 'auto',
  }
  await saveConfig(cfg)

  const keyed =
    Boolean(profile.apiKey) || Boolean(profile.apiKeyEnv && process.env[profile.apiKeyEnv])
  process.stderr.write(`\n${BOLD}已写入${RESET} ${configPath()}\n`)
  if (!keyed && preset.key !== 'local') {
    process.stderr.write(
      `${DIM}还差 key：设置环境变量 ${profile.apiKeyEnv}，或往配置文件里加 "apiKey"。${RESET}\n`,
    )
  } else {
    process.stderr.write(`${DIM}试一下：qy exec "介绍一下这个目录里的代码"${RESET}\n`)
  }
  return 0
}

function templateConfig(): QyConfig {
  const preset = PRESETS[0]!
  return {
    active: preset.key,
    profiles: { [preset.key]: { ...preset.profile, apiKey: 'sk-你的key' } },
    effort: 'high',
    mode: 'auto',
  }
}

async function readLine(): Promise<string> {
  for await (const line of console) return line
  return ''
}
