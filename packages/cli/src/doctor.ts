/**
 * `qy doctor`：在一屏内显示本机的当前状态。
 *
 * **用途。** 这些事实都已能够计算，但**分散在四条命令和一份日志中**：
 * `qy config` 报告配置与沙箱、`qy mcp` 报告 MCP、`qy plugins` 报告插件隔离、
 * `qy usage` 报告花费。用户要回答「当前边界是什么、扩展是否都在运行」，
 * 需要逐条执行，再自行汇总结论。
 *
 * 其中沙箱一项**通常在出现问题之后才被检查**：无内核边界是多数机器的默认状态，
 * 且不产生任何错误信号。
 *
 * **三条设计约束**：
 * 1. **不产生费用、不发请求。** 需要计费的体检命令用户不会经常运行，
 *    而不经常运行的体检没有作用。因此这里只检查本地事实：配置、沙箱、账本、
 *    MCP 与插件的连通性（二者本身需要启动子进程）。
 *    端点能力的实测由 `qy probe` 负责，不并入此处。
 * 2. **分级而不是打分。** 输出只有三种前缀：`✗` 阻断、`⚠` 警告、`✓` 正常。
 *    合成的「健康度 87 分」既不可操作也不可验证。
 * 3. **退出码只由 `✗` 决定。** `⚠` 不返回非零：否则无内核沙箱的机器上退出码恒为非零。
 */

import { stat } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import {
  configDir,
  configNotices,
  configPath,
  dataPath,
  diagnoseConfig,
  diagnoseRunnable,
  globalPluginsDir,
  loadConfig,
  loadExtensions,
  loadWorkspaceMcp,
  MCP_CONFIG,
  resolveModel,
  toolNamePrefix,
} from '@qywork/runtime'
import { contentPathFor, type ModelFinishRate, providerFinishRates, Store } from '@qywork/store'
import { detectSandbox } from '@qywork/tools'

const DIM = '\x1b[2m'
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'

type Level = 'ok' | 'warn' | 'fail'

export interface Line {
  level: Level
  text: string
  /** 补充说明，缩进显示。内容应可直接据此操作，不写「请检查配置」这类笼统说明。 */
  detail?: string
}

const MARK: Record<Level, string> = {
  ok: `${GREEN}✓${RESET}`,
  warn: `${YELLOW}⚠${RESET}`,
  fail: `${RED}✗${RESET}`,
}

export interface Section {
  title: string
  lines: Line[]
}

/**
 * 执行全部检查，返回结构化结果。
 *
 * **与渲染分离**是为了便于测试：判定逻辑若嵌入 `process.stderr.write`，测试只能比对带
 * ANSI 转义的字符串，而绑定文案的断言最终会被弱化为「只断言不抛异常」。
 */
export async function collectDoctorReport(workspaceRoot: string): Promise<Section[]> {
  return [
    { title: '配置', lines: await checkConfig() },
    { title: 'shell 沙箱', lines: checkSandbox() },
    { title: '账本与正文库', lines: await checkStore() },
    { title: '请求完成率', lines: await checkFinishRates() },
    { title: 'MCP', lines: await checkMcp(workspaceRoot) },
    { title: '插件', lines: await checkPlugins(workspaceRoot) },
  ]
}

export async function runDoctor(args: string[]): Promise<number> {
  const cwdFlag = args.indexOf('--cwd')
  const workspaceRoot = resolve(cwdFlag >= 0 ? (args[cwdFlag + 1] ?? '.') : '.')
  const json = args.includes('--json')

  const sections = await collectDoctorReport(workspaceRoot)

  const all = sections.flatMap((s) => s.lines)
  const fails = all.filter((l) => l.level === 'fail').length
  const warns = all.filter((l) => l.level === 'warn').length

  if (json) {
    // stdout 只输出 JSON，供脚本解析。供人阅读的内容一律写入 stderr。
    process.stdout.write(
      `${JSON.stringify({ workspaceRoot, sections, summary: { fails, warns } }, null, 2)}\n`,
    )
  } else {
    process.stderr.write(`工作区：${workspaceRoot}\n\n`)
    for (const s of sections) {
      process.stderr.write(`${BOLD}${s.title}${RESET}\n`)
      for (const l of s.lines) {
        process.stderr.write(`  ${MARK[l.level]} ${l.text}\n`)
        if (l.detail) {
          for (const d of l.detail.split('\n')) process.stderr.write(`      ${DIM}${d}${RESET}\n`)
        }
      }
      process.stderr.write('\n')
    }
    process.stderr.write(
      fails === 0 && warns === 0
        ? `${GREEN}一切正常${RESET}\n`
        : `${fails} 项阻断 · ${warns} 项警告\n`,
    )
  }

  // **只有存在阻断项时才返回非零。** 若警告也返回非零，无内核沙箱的机器上退出码恒为非零。
  return fails > 0 ? 1 : 0
}

// ───────────────────────── 各项检查 ─────────────────────────

async function checkConfig(): Promise<Line[]> {
  const out: Line[] = []
  const cfg = await loadConfig()

  const problems = [...diagnoseConfig(cfg), ...diagnoseRunnable(cfg)]
  for (const p of problems) {
    const [head, ...rest] = p.split('\n')
    out.push({
      level: 'fail',
      text: head ?? p,
      ...(rest.length ? { detail: rest.join('\n') } : {}),
    })
  }
  if (problems.length === 0) {
    if (!cfg.active) {
      // 未配置模型时无法发出任何请求，与「没有 key」同属阻断项，判定为 fail，
      // 使 `qy doctor` 在尚未配置的机器上返回非零。
      out.push({
        level: 'fail',
        text: '未配置模型',
        detail: '在设置中选择接口和模型，或运行 qy init',
      })
    } else {
      const active = resolveModel(cfg)
      out.push({
        level: 'ok',
        text: `接口 ${cfg.active.provider}（${active?.kind} · ${cfg.active.model}）`,
        detail: configPath(),
      })
    }
  }

  for (const n of configNotices(cfg)) {
    const [head, ...rest] = n.split('\n')
    out.push({
      level: 'warn',
      text: head ?? n,
      ...(rest.length ? { detail: rest.join('\n') } : {}),
    })
  }

  out.push({
    level: 'ok',
    text: `权限模式 ${cfg.mode ?? 'auto'}`,
    detail:
      (cfg.mode ?? 'auto') === 'full'
        ? '不裁决，全部放行（凭证剥离仍然生效）'
        : '不弹出确认框，由硬边界与静态规则裁决',
  })

  return out
}

function checkSandbox(): Line[] {
  const s = detectSandbox()
  const where = s.wsl === null ? s.platform : `${s.platform} · WSL${s.wsl}`
  return [
    {
      // 没有内核边界属于**警告而不是失败**：绝大多数 Windows 机器处于这一状态，
      // 判定为 fail 会使 `qy doctor` 在这些机器上始终返回非零，退出码因此失去意义。
      level: s.active ? 'ok' : 'warn',
      text: `${s.backend}（${where}）`,
      detail: s.reason,
    },
  ]
}

/** 完成率低于该值时给出警告。在完成率低于该值的端点上，长任务的成功率随轮数连乘下降。 */
const FINISH_WARN_RATIO = 0.9
/** 样本少于该数时不下结论：三次中失败一次不足以说明问题。 */
const FINISH_MIN_SAMPLES = 5
const FINISH_WINDOW_DAYS = 7

/**
 * 按模型报告请求完成率。
 *
 * 放在 doctor 中的原因：这是「该端点在本机是否稳定」唯一的本地依据，而账本
 * 逐行记录了它（`provider_requests` 的 `status` / `error_code`）。只执行 SELECT，
 * 不发请求，符合本文件开头第 1 条约束。
 *
 * **不做主动探测。** 断流只在长时间生成中出现，几次小请求要么无法测出、要么产生实际费用，
 * 而在不稳定的线路上几次采样给出的是随机结果。
 */
async function checkFinishRates(): Promise<Line[]> {
  const db = dataPath()
  try {
    await stat(db)
  } catch {
    return [{ level: 'ok', text: '账本尚未建立，无样本' }]
  }
  const since = Date.now() - FINISH_WINDOW_DAYS * 86_400_000
  const store = new Store({ path: db })
  let rows: ModelFinishRate[]
  try {
    rows = providerFinishRates(store, since)
  } finally {
    store.close()
  }
  if (rows.length === 0) {
    return [{ level: 'ok', text: `最近 ${FINISH_WINDOW_DAYS} 天没有请求记录` }]
  }
  return rows.map((r) => {
    const ratio = r.total === 0 ? 1 : r.received / r.total
    const shaky = r.total >= FINISH_MIN_SAMPLES && ratio < FINISH_WARN_RATIO
    const detail = [
      r.uncertain > 0 ? `结果不明 ${r.uncertain}` : '',
      r.rejected > 0 ? `被拒绝 ${r.rejected}` : '',
      r.topErrorCode ? `最常见错误码 ${r.topErrorCode}` : '',
    ]
      .filter(Boolean)
      .join('，')
    return {
      level: shaky ? 'warn' : 'ok',
      text: `${r.model} ${r.received}/${r.total} 完成`,
      ...(detail ? { detail } : {}),
    }
  })
}

async function checkStore(): Promise<Line[]> {
  const out: Line[] = []
  const db = dataPath()
  try {
    const info = await stat(db)
    out.push({ level: 'ok', text: `账本 ${mb(info.size)}`, detail: db })
  } catch {
    // 尚未建库不是错误：首次执行任务之前数据库不存在。
    out.push({ level: 'ok', text: '账本尚未建立（首次执行任务时创建）', detail: db })
  }

  const content = contentPathFor(db)
  try {
    const info = await stat(content)
    out.push({ level: 'ok', text: `正文库 ${mb(info.size)}`, detail: content })
  } catch {
    out.push({ level: 'ok', text: '正文库尚未建立', detail: content })
  }

  // 目录可写是**能否记账**的前提：不可写时每一轮的花费被静默丢弃，账本中不留缺失标记。
  try {
    const probe = `${configDir()}/.doctor-write-probe`
    await Bun.write(probe, 'x')
    await Bun.file(probe).delete()
    out.push({ level: 'ok', text: '配置目录可写' })
  } catch (e) {
    out.push({
      level: 'fail',
      text: '配置目录不可写：用量无法写入账本，配置也无法保存',
      detail: `${configDir()}\n${e instanceof Error ? e.message : String(e)}`,
    })
  }
  return out
}

async function checkMcp(workspaceRoot: string): Promise<Line[]> {
  // 此处不收集加载日志：加载日志供 `qy mcp --tools` 逐行查看，
  // 体检只需要结论。收集而不输出会产生一份没有消费者的数据。
  const reg = await loadWorkspaceMcp(workspaceRoot, () => {})
  const out: Line[] = []

  if (reg.servers.length === 0 && reg.failures.length === 0) {
    out.push({ level: 'ok', text: '没有配置 MCP server', detail: MCP_CONFIG })
    reg.stopAll()
    return out
  }

  for (const s of reg.servers) {
    const tools = reg.toolSpecs.filter((t) => t.name.startsWith(toolNamePrefix(s.name))).length
    out.push({
      level: s.unsupported.length ? 'warn' : 'ok',
      text: `${s.name} · ${s.client.transportKind} · ${tools} 个工具`,
      ...(s.unsupported.length
        ? { detail: `server 另外声明了 qywork 尚未支持的能力：${s.unsupported.join('、')}` }
        : {}),
    })
  }
  for (const f of reg.failures) {
    out.push({ level: 'fail', text: `${f.server} 未就绪`, detail: f.reason })
  }

  // 已启动的子进程必须终止。体检命令遗留孤儿进程，危害大于不做体检。
  reg.stopAll()
  return out
}

async function checkPlugins(workspaceRoot: string): Promise<Line[]> {
  const out: Line[] = []
  const ext = await loadExtensions(workspaceRoot)
  const reg = ext.plugins

  try {
    if (reg.plugins.length === 0 && reg.failures.length === 0) {
      out.push({ level: 'ok', text: '没有安装插件', detail: globalPluginsDir() })
      return out
    }

    for (const p of reg.plugins) {
      const rt = p.host?.runtime
      if (!p.host) {
        // 纯声明式插件没有进程，不涉及隔离。应表述为不适用，而不是「没有隔离」：
        // 后者会被理解为一处故障。
        out.push({ level: 'ok', text: `${p.manifest.id} · 纯声明式，无代码进程` })
        continue
      }
      if (!rt) {
        out.push({ level: 'warn', text: `${p.manifest.id} · 进程未启动，隔离状态未知` })
        continue
      }
      // 两个维度分开报告，不合并为「已隔离」：二者的成立条件不同（版本要求不同，
      // bun 上两者都不具备），合并后「已隔离」在不同机器上含义不同。
      const bits = `沙箱 ${rt.sandboxed ? '有' : '无'} · 网络访问限制 ${rt.netGuarded ? '有' : '无'}`
      out.push({
        level: rt.sandboxed && rt.netGuarded ? 'ok' : 'warn',
        text: `${p.manifest.id} · ${bits}`,
        detail: rt.note,
      })
    }

    for (const f of reg.failures) {
      const where = relative(workspaceRoot, f.dir) || f.dir
      out.push({ level: 'fail', text: `${where} 加载失败`, detail: f.reason })
    }
  } finally {
    // 探测完成后终止子进程，否则该命令会阻塞而不返回。
    await ext.stop()
  }
  return out
}

function mb(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
