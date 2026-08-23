/**
 * `qy doctor` —— 一屏看完「我这台机器上，它现在到底处于什么状态」。
 *
 * ## 为什么需要它
 *
 * 这些事实已经全都算得出来了，但**分散在四条命令和一个日志里**：
 * `qy config` 报配置与沙箱、`qy mcp` 报 MCP、`qy plugins` 报插件隔离、
 * `qy usage` 报花销。用户想回答「我现在安全吗 / 我的扩展都活着吗」，
 * 得挨个跑一遍，还得自己把结论拼起来。
 *
 * 而其中一部分事实**只有在出问题之后才有人去查**——尤其是沙箱那条。
 * 「没有内核边界」是很多机器上的默认状态，它不会主动报错，
 * 只会在某天模型删掉了工作区外的东西之后才被想起来。
 *
 * ## 三条设计约束
 *
 * 1. **不花钱、不发请求。** 一条要计费的体检命令，用户不会常跑，
 *    而不常跑的体检等于没有。所以这里只查本地事实：配置、沙箱、账本、
 *    MCP 与插件的连通性（那两个本来就要起子进程）。
 *    想实测端点能力是 `qy probe` 的事，不并进来。
 * 2. **分级而不是打分。** 输出只有三种前缀：`✗` 阻断、`⚠` 要知道、`✓` 正常。
 *    合成一个「健康度 87 分」既不可操作也不可验证。
 * 3. **退出码只由 `✗` 决定。** `⚠` 不退非零——否则 CI 里挂着一堆
 *    「没有内核沙箱」的黄灯，很快就没人看退出码了。
 */

import { stat } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import {
  configDir,
  configNotices,
  configPath,
  dataPath,
  diagnoseConfig,
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
  /** 补充说明，缩进显示。要能直接照着做，不要「请检查配置」这种。 */
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
 * 跑完全部检查，返回结构化结果。
 *
 * **与渲染分开**是为了可测：把判定埋在一堆 `process.stderr.write` 中间的话，
 * 测试只能去比对带 ANSI 转义的字符串——那种断言一改文案就红，
 * 于是很快会被改成「只断言不抛异常」，等于什么都没验。
 */
export async function collectDoctorReport(workspaceRoot: string): Promise<Section[]> {
  return [
    { title: '配置', lines: await checkConfig() },
    { title: 'shell 沙箱', lines: checkSandbox() },
    { title: '账本与正文库', lines: await checkStore() },
    { title: '端点收尾', lines: await checkFinishRates() },
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
    // stdout 只放 JSON，给脚本消费。人看的东西一律走 stderr。
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
        : `${fails} 项阻断 · ${warns} 项需要知道\n`,
    )
  }

  // **只有阻断项才退非零。** 黄灯退非零的话，CI 里挂着一堆
  // 「这台机器没有内核沙箱」的警告，很快就没人看退出码了。
  return fails > 0 ? 1 : 0
}

// ───────────────────────── 各项检查 ─────────────────────────

async function checkConfig(): Promise<Line[]> {
  const out: Line[] = []
  const cfg = await loadConfig()

  const problems = diagnoseConfig(cfg)
  for (const p of problems) {
    const [head, ...rest] = p.split('\n')
    out.push({
      level: 'fail',
      text: head ?? p,
      ...(rest.length ? { detail: rest.join('\n') } : {}),
    })
  }
  if (problems.length === 0) {
    const active = resolveModel(cfg)
    out.push({
      level: 'ok',
      text: `接口 ${cfg.active.provider}（${active?.kind} · ${cfg.active.model}）`,
      detail: configPath(),
    })
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
        ? '不裁决，全放行（凭证剥离与禁止改 .qy/ 仍然生效）'
        : '不弹窗，由硬边界 + 静态规则 + 分类器裁决',
  })

  return out
}

function checkSandbox(): Line[] {
  const s = detectSandbox()
  const where = s.wsl === null ? s.platform : `${s.platform} · WSL${s.wsl}`
  return [
    {
      // 没有内核边界是**警告不是失败**：绝大多数 Windows 机器都是这个状态，
      // 判成 fail 会让 `qy doctor` 在那些机器上永远退非零，于是退出码失去意义。
      level: s.active ? 'ok' : 'warn',
      text: `${s.backend}（${where}）`,
      detail: s.reason,
    },
  ]
}

/** 收尾率低于这个数就值得说一句。低于它的端点上，长任务是逐轮连乘着掉的。 */
const FINISH_WARN_RATIO = 0.9
/** 样本少于这个数不下结论——三次里错一次说明不了什么。 */
const FINISH_MIN_SAMPLES = 5
const FINISH_WINDOW_DAYS = 7

/**
 * 按模型报请求收尾率。
 *
 * 为什么在 doctor 里：这是「这条端点在我这里稳不稳」的唯一本地答案，而账本
 * 逐行记着它（`provider_requests` 的 `status` / `error_code`）。纯 SELECT，
 * 不发请求，符合本文件开头第 1 条约束。
 *
 * **不做主动探测。** 断流只在长生成上显形，几次小请求要么测不出、要么烧真钱，
 * 而在不稳的线路上几次采样给出的是随机结果。
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
      r.uncertain > 0 ? `连接未收尾 ${r.uncertain}` : '',
      r.rejected > 0 ? `被回绝 ${r.rejected}` : '',
      r.topErrorCode ? `最多的错误码 ${r.topErrorCode}` : '',
    ]
      .filter(Boolean)
      .join('，')
    return {
      level: shaky ? 'warn' : 'ok',
      text: `${r.model} ${r.received}/${r.total} 收尾`,
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
    // 还没建库不是错误——第一次跑之前它本来就不存在。
    out.push({ level: 'ok', text: '账本尚未建立（第一次执行任务时创建）', detail: db })
  }

  const content = contentPathFor(db)
  try {
    const info = await stat(content)
    out.push({ level: 'ok', text: `正文库 ${mb(info.size)}`, detail: content })
  } catch {
    out.push({ level: 'ok', text: '正文库尚未建立', detail: content })
  }

  // 目录可写是**能不能记账**的前提。不可写的话每一轮的花销都会静默丢掉，
  // 而用户只会在月底对不上账时才发现。
  try {
    const probe = `${configDir()}/.doctor-write-probe`
    await Bun.write(probe, 'x')
    await Bun.file(probe).delete()
    out.push({ level: 'ok', text: '配置目录可写' })
  } catch (e) {
    out.push({
      level: 'fail',
      text: '配置目录不可写——用量记不进账本，配置也保存不了',
      detail: `${configDir()}\n${e instanceof Error ? e.message : String(e)}`,
    })
  }
  return out
}

async function checkMcp(workspaceRoot: string): Promise<Line[]> {
  // 加载日志在这里不收：它们是给 `qy mcp --tools` 逐行看的，
  // 体检要的是结论。收了不打就是又一条「算出来没人消费」。
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
        ? { detail: `server 还声明了 qywork 未支持的能力：${s.unsupported.join('、')}` }
        : {}),
    })
  }
  for (const f of reg.failures) {
    out.push({ level: 'fail', text: `${f.server} 未就绪`, detail: f.reason })
  }

  // 起过的子进程必须收掉。体检命令留下一堆孤儿进程比不做体检糟。
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
        // 纯声明式插件没有进程，也就无所谓隔离。说「不适用」而不是「没有隔离」——
        // 后者会让人以为出了问题。
        out.push({ level: 'ok', text: `${p.manifest.id} · 纯声明式，无代码进程` })
        continue
      }
      if (!rt) {
        out.push({ level: 'warn', text: `${p.manifest.id} · 进程未启动，隔离状态未知` })
        continue
      }
      // 两个维度分开报，不合并成「已隔离」——它们的成立条件不同（版本要求不同，
      // bun 上一个都没有），合成一句话之后「已隔离」在不同机器上就不是一个意思了。
      const bits = `沙箱 ${rt.sandboxed ? '有' : '无'} · 出网闸 ${rt.netGuarded ? '有' : '无'}`
      out.push({
        level: rt.sandboxed && rt.netGuarded ? 'ok' : 'warn',
        text: `${p.manifest.id} · ${bits}`,
        detail: rt.note,
      })
    }

    for (const f of reg.failures) {
      const where = relative(workspaceRoot, f.dir) || f.dir
      out.push({ level: 'fail', text: `${where} 未装上`, detail: f.reason })
    }
  } finally {
    // 探测完就把子进程收掉。留着的话这条命令会挂住不返回。
    ext.stop()
  }
  return out
}

function mb(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
