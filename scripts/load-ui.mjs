#!/usr/bin/env node
/**
 * 前端定长负载量测：100 / 1000 条历史会话下的首屏、切换、变更翻页与运行面板读数。
 *
 * 用 Node 而不是 Bun 驱动 Playwright：Bun 在 Windows 上对 `--remote-debugging-pipe`
 * 用到的 fd 3/4 管道支持不全，`chromium.launch()` 会挂到超时。
 *
 * 走的是发布路径：`qy serve --static apps/web/dist` 托管生产构建，不经 Vite 代理。
 * 同一份数据连量两轮，第一轮是基线，第二轮判趋势——阈值先固定，不事后放宽。
 *
 *   bun run build:web && node scripts/load-ui.mjs
 */

import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = join(ROOT, '.tmp', 'load-ui')
const SHOTS = join(BASE, 'shots')

const SIZES = [100, 1000]
const ROUNDS = 2
/** 每一档量几条会话的切换延迟。取分散的序号，避开列表顶部那几条的缓存优势。 */
const SWITCH_PICKS = [3, 25, 60, 88, 97]

function run(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {
      cwd: ROOT,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env, ...env },
    })
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`))))
    p.on('error', reject)
  })
}

async function startServer(home, wsDir) {
  const proc = spawn(
    'bun',
    [
      'run',
      join(ROOT, 'packages/cli/src/index.ts'),
      'serve',
      '--port',
      '0',
      '--host',
      '127.0.0.1',
      '--cwd',
      wsDir,
      '--static',
      join(ROOT, 'apps/web/dist'),
      '--print-token',
      // Windows 上 shell:true 时 proc 是 cmd.exe，proc.kill() 杀的是壳不是 bun。
      // 让服务自己盯父进程，留下的服务会占着 SQLite 的 WAL 锁。
      '--parent-pid',
      String(process.pid),
    ],
    {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: { ...process.env, QYWORK_HOME: home },
    },
  )
  return new Promise((resolve, reject) => {
    let token = null
    let port = null
    let buf = ''
    const timer = setTimeout(() => reject(new Error('serve 启动超时')), 60_000)
    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString()
      for (const line of buf.split('\n')) {
        const t = /^QYWORK_TOKEN=(.+)$/.exec(line.trim())
        if (t) token = t[1]
        const p = /^QYWORK_PORT=(\d+)$/.exec(line.trim())
        if (p) port = Number(p[1])
      }
      if (token && port) {
        clearTimeout(timer)
        resolve({ proc, token, port })
      }
    })
    proc.stderr.on('data', () => {})
    proc.on('error', reject)
    proc.on('exit', (code) => {
      if (!token) {
        clearTimeout(timer)
        reject(new Error(`serve 提前退出 code=${code}`))
      }
    })
  })
}

/** 打开右侧面板并翻到某一页。页签是 `role="tab"` 带文字，面板默认收着。 */
async function openPanelTab(page, label) {
  const expand = page.locator('[aria-label="展开侧面板"]')
  if (await expand.count()) await expand.click()
  await page.getByRole('tab', { name: label, exact: true }).click()
}

async function measureRound(page, size, errors, tag, url) {
  const out = {}

  // 首屏：从导航开始到侧栏第一行会话可见。
  // 先离开当前文档：`waitUntil: 'commit'` 之后旧 DOM 可能还在，直接量会量到上一页的行。
  await page.goto('about:blank')
  const t0 = Date.now()
  await page.goto(url, { waitUntil: 'commit' })
  await page.locator('.conv-row').first().waitFor({ state: 'visible', timeout: 60_000 })
  out.firstRowMs = Date.now() - t0
  await page.waitForLoadState('networkidle')
  out.settledMs = Date.now() - t0
  out.rows = await page.locator('.conv-row').count()

  // 切换：点一条会话到它那句用户消息出现在会话流里。
  const switches = []
  for (const n of SWITCH_PICKS) {
    const index = Math.min(n, size)
    const title = `历史会话 ${String(index).padStart(4, '0')}`
    const row = page.locator('.conv-open', { hasText: title }).first()
    if ((await row.count()) === 0) {
      errors.push(`[${tag}] 侧栏里找不到 ${title}`)
      continue
    }
    const start = Date.now()
    await row.click()
    try {
      await page
        .locator('.conversation-stream-inner')
        .getByText(`第 ${index} 条历史请求`, { exact: false })
        .first()
        .waitFor({ state: 'visible', timeout: 30_000 })
      switches.push(Date.now() - start)
    } catch (e) {
      errors.push(`[${tag}] 切到 ${title} 超时：${e.message}`)
    }
  }
  out.switchMs = switches
  out.switchP50 = switches.length
    ? switches.slice().sort((a, b) => a - b)[switches.length >> 1]
    : null
  out.switchMax = switches.length ? Math.max(...switches) : null

  // 变更页：切到有 30 轮写入的那条会话，先量首页，再滚到列表末尾逐页翻。
  {
    const row = page.locator('.conv-open', { hasText: '变更分页' }).first()
    if ((await row.count()) === 0) errors.push(`[${tag}] 侧栏里找不到「变更分页」`)
    else await row.click()
  }
  await openPanelTab(page, '变更')
  const cStart = Date.now()
  try {
    await page.locator('.change-turn').first().waitFor({ state: 'visible', timeout: 30_000 })
    out.changesFirstMs = Date.now() - cStart
  } catch (e) {
    out.changesFirstMs = null
    errors.push(`[${tag}] 变更页没渲染出来：${e.message}`)
  }
  out.changesPages = []
  let turns = await page.locator('.change-turn').count()
  out.changesFirstPageTurns = turns
  for (let page_i = 0; page_i < 3; page_i++) {
    const pStart = Date.now()
    await page
      .locator('.change-more')
      .scrollIntoViewIfNeeded()
      .catch(() => {})
    let grown = turns
    for (let wait = 0; wait < 40; wait++) {
      await page.waitForTimeout(100)
      grown = await page.locator('.change-turn').count()
      if (grown > turns) break
    }
    if (grown === turns) break
    out.changesPages.push({ ms: Date.now() - pStart, turns: grown })
    turns = grown
  }
  out.changesTurns = turns

  // 输入延迟：往输入框敲 200 个字符，量整段耗时与最慢的那一次按键。
  {
    const box = page.locator('textarea[placeholder="随心输入，可粘贴图片"]').first()
    if ((await box.count()) === 0) errors.push(`[${tag}] 找不到输入框`)
    else {
      await box.click()
      const keys = []
      const text = '负载输入延迟量测'.repeat(25)
      const start = Date.now()
      // 逐字 `keyboard.type`：`press` 只认按键名，中日韩字符会直接抛。
      for (const ch of text) {
        const k0 = Date.now()
        await page.keyboard.type(ch)
        keys.push(Date.now() - k0)
      }
      out.typeTotalMs = Date.now() - start
      out.typeChars = text.length
      out.typeMaxMs = Math.max(...keys)
      out.typeP50Ms = keys.slice().sort((a, b) => a - b)[keys.length >> 1]
      out.typeValueOk = (await box.inputValue()) === text
      if (!out.typeValueOk) errors.push(`[${tag}] 输入框内容与敲进去的不一致`)
      await box.fill('')
    }
  }

  // 运行面板：1 / 4 / 12 并行子任务各开一次。
  out.runPanelMs = {}
  for (const fanout of [1, 4, 12]) {
    const row = page.locator('.conv-open', { hasText: `并行子任务 ${fanout}` }).first()
    if ((await row.count()) === 0) {
      errors.push(`[${tag}] 侧栏里找不到「并行子任务 ${fanout}」`)
      continue
    }
    await row.click()
    await openPanelTab(page, '运行')
    const rStart = Date.now()
    try {
      await page.locator('.run-row').first().waitFor({ state: 'visible', timeout: 30_000 })
      out.runPanelMs[fanout] = Date.now() - rStart
    } catch (e) {
      out.runPanelMs[fanout] = null
      errors.push(`[${tag}] 运行面板（${fanout} 个子任务）没渲染出来：${e.message}`)
    }
    if (fanout === 12) {
      await page.screenshot({ path: join(SHOTS, `${tag}-runs-12.png`) })
    }
  }

  await page.screenshot({ path: join(SHOTS, `${tag}-desktop.png`) })
  return out
}

async function measureNarrow(page, errors, tag) {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(600)
  // 侧面板在 390px 下铺满整个视口，留着量到的是面板不是会话视图。
  const close = page.locator('[aria-label="关闭面板"]')
  if (await close.count()) await close.click()
  await page.waitForTimeout(500)
  if (await page.locator('.side-panel').count()) {
    errors.push(`[${tag}] 390px 下关不掉侧面板，量到的是面板不是会话视图`)
  }
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement
    const wide = [...document.querySelectorAll('*')]
      .filter((el) => el.scrollWidth > el.clientWidth + 4 && el.clientWidth > 0)
      .filter((el) => {
        const style = getComputedStyle(el)
        return style.overflowX !== 'auto' && style.overflowX !== 'scroll'
      })
      .slice(0, 8)
      .map(
        (el) =>
          `${el.tagName.toLowerCase()}.${el.className || '(无类)'}: ${el.scrollWidth}>${el.clientWidth}`,
      )
    return { docOverflow: doc.scrollWidth - doc.clientWidth, wide }
  })
  if (overflow.docOverflow > 0)
    errors.push(`[${tag}] 390px 下文档横向溢出 ${overflow.docOverflow}px`)
  await page.screenshot({ path: join(SHOTS, `${tag}-390.png`) })
  await page.click('.drawer-toggle').catch(() => {})
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(SHOTS, `${tag}-390-drawer.png`) })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForTimeout(400)
  return overflow
}

async function main() {
  await rm(BASE, { recursive: true, force: true })
  await mkdir(SHOTS, { recursive: true })

  const report = { at: new Date().toISOString(), sizes: {} }
  const errors = []

  for (const size of SIZES) {
    const home = join(BASE, `home-${size}`)
    const wsDir = join(BASE, `ws-${size}`)
    await mkdir(home, { recursive: true })
    await mkdir(join(wsDir, 'src'), { recursive: true })
    await writeFile(join(wsDir, 'README.md'), '# 负载夹具\n', 'utf8')
    // 种下的会话绑的是 fake/deepseek-v4-flash。配置里没有这一对时
    // `/api/conversations/:id/context` 回 409，每切一条会话就往控制台记一条错误。
    await writeFile(
      join(home, 'config.json'),
      JSON.stringify({
        active: { provider: 'fake', model: 'deepseek-v4-flash' },
        providers: {
          fake: {
            kind: 'openai_responses',
            apiKey: 'sk-load-ui',
            baseUrl: 'http://127.0.0.1:9/v1',
            models: { 'deepseek-v4-flash': {} },
          },
        },
        mode: 'auto',
      }),
      'utf8',
    )
    await run('bun', [
      'run',
      join(ROOT, 'scripts/load-serve.ts'),
      'seed',
      join(home, 'qywork.sqlite3'),
      wsDir,
      String(size),
    ])

    const { proc, token, port } = await startServer(home, wsDir)
    const base = `http://127.0.0.1:${port}`
    process.stdout.write(`${size} 条：服务已起 ${base}\n`)

    const browser = await chromium.launch()
    try {
      const rounds = []
      for (let r = 1; r <= ROUNDS; r++) {
        const tag = `${size}-r${r}`
        const ctx = await browser.newContext({
          viewport: { width: 1440, height: 900 },
          colorScheme: 'light',
        })
        const page = await ctx.newPage()
        page.on('console', (m) => {
          if (m.type() === 'error') errors.push(`[${tag}] console: ${m.text()}`)
        })
        page.on('pageerror', (e) => errors.push(`[${tag}] pageerror: ${e.message}`))

        const navStart = Date.now()
        await page.goto(`${base}/#t=${token}`, { waitUntil: 'commit' })
        await page.locator('.conv-row').first().waitFor({ state: 'visible', timeout: 60_000 })
        const coldFirstRowMs = Date.now() - navStart
        await page.waitForLoadState('networkidle')
        if (await page.locator('.conn-bar').count()) {
          errors.push(`[${tag}] 未连上：${await page.locator('.conn-bar').first().textContent()}`)
        }

        const m = await measureRound(page, size, errors, tag, `${base}/#t=${token}`)
        m.coldFirstRowMs = coldFirstRowMs
        m.narrow = await measureNarrow(page, errors, tag)
        rounds.push(m)
        await ctx.close()
      }
      report.sizes[size] = rounds
    } finally {
      await browser.close()
      proc.kill()
      await new Promise((r) => setTimeout(r, 1500))
    }
  }

  report.errors = errors
  await writeFile(join(BASE, 'metrics.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`\n读数已写入 ${join(BASE, 'metrics.json')}\n`)
  if (errors.length) {
    process.stdout.write('\n问题：\n')
    for (const e of errors) process.stdout.write(`  ✗ ${e}\n`)
    return 1
  }
  return 0
}

process.exit(await main())
