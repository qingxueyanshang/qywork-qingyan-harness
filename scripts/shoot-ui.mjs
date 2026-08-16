#!/usr/bin/env node
/**
 * 界面截图验证。
 *
 * 用 Node 而不是 Bun 驱动 Playwright：Bun 在 Windows 上对 `--remote-debugging-pipe`
 * 用到的 fd 3/4 管道支持不全，`chromium.launch()` 会挂到超时。所以这里分工——
 * Node 管浏览器，Bun 管服务，各自做自己稳的那部分。
 *
 * 顺带把真实发布路径也验了：它启动的是 `qy serve --static`（静态托管构建产物），
 * 与开发时的 Vite 代理不是同一条路，那条路不测就等于没测。
 *
 *   node scripts/shoot-ui.mjs
 */

import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WS_DIR = join(ROOT, '.shoot-ws')
const OUT = join(ROOT, '.shots')

const SHOTS = [
  { name: 'desktop-light', width: 1440, height: 900, scheme: 'light' },
  { name: 'desktop-dark', width: 1440, height: 900, scheme: 'dark' },
  { name: 'mobile-light', width: 390, height: 844, scheme: 'light' },
  { name: 'mobile-dark', width: 390, height: 844, scheme: 'dark' },
]

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {
      cwd: ROOT,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`))))
    p.on('error', reject)
  })
}

async function startServer() {
  await rm(WS_DIR, { recursive: true, force: true })
  await mkdir(WS_DIR, { recursive: true })
  await mkdir(join(WS_DIR, 'src'), { recursive: true })
  await writeFile(join(WS_DIR, 'index.ts'), 'export const hello = 1\n', 'utf8')
  await writeFile(join(WS_DIR, 'README.md'), '# demo\n\n用于界面截图的工作区。\n', 'utf8')
  await writeFile(
    join(WS_DIR, 'src/main.ts'),
    'export function add(a: number, b: number): number {\n  return a + b\n}\n',
    'utf8',
  )

  // 建成真实 git 仓库并留下未提交改动，否则 git 面板只能截到「不是 git 仓库」。
  const git = (...args) => run('git', ['-C', WS_DIR, ...args]).catch(() => {})
  await git('init', '-q')
  await git('config', 'user.email', 'demo@qywork.dev')
  await git('config', 'user.name', 'qywork')
  await git('add', '-A')
  await git('commit', '-q', '-m', 'init')
  await writeFile(
    join(WS_DIR, 'src/main.ts'),
    'export function add(a: number, b: number): number {\n  return a + b\n}\n\nexport function mul(a: number, b: number): number {\n  return a * b\n}\n',
    'utf8',
  )
  await writeFile(join(WS_DIR, 'src/util.ts'), 'export const noop = () => {}\n', 'utf8')

  // QYWORK_HOME 把配置与账本一起指到临时目录：既不污染用户的真实账本，
  // 也保证种子和 serve 读的是同一个库（config.dataPath() 就在这个目录下）。
  await run('bun', [
    'run',
    join(ROOT, 'scripts/seed-demo.ts'),
    join(WS_DIR, 'qywork.sqlite3'),
    WS_DIR,
  ])

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
      WS_DIR,
      '--static',
      join(ROOT, 'apps/web/dist'),
      '--print-token',
      // Windows 上 shell:true 时 proc 是 cmd.exe，proc.kill() 杀的是壳不是 bun，
      // 留下的服务占着 SQLite 的 WAL 锁，下次跑这个脚本会在 rm 工作区时报 EBUSY。
      // 让服务自己盯父进程——和 Tauri sidecar 用的是同一条兜底。
      '--parent-pid',
      String(process.pid),
    ],
    {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: { ...process.env, QYWORK_HOME: WS_DIR },
    },
  )

  return new Promise((resolve, reject) => {
    let token = null
    let port = null
    let buf = ''
    const timer = setTimeout(() => reject(new Error('serve 启动超时')), 30_000)

    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString()
      // --print-token 的输出格式是稳定的两行 KEY=VALUE，供父进程按行读取。
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

async function main() {
  await mkdir(OUT, { recursive: true })
  const { proc, token, port } = await startServer()
  const base = `http://127.0.0.1:${port}`
  process.stdout.write(`服务已起：${base}\n`)

  const browser = await chromium.launch()
  const errors = []

  try {
    for (const shot of SHOTS) {
      const ctx = await browser.newContext({
        viewport: { width: shot.width, height: shot.height },
        colorScheme: shot.scheme,
        deviceScaleFactor: 2,
      })
      const page = await ctx.newPage()
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`[${shot.name}] console: ${m.text()}`)
      })
      page.on('pageerror', (e) => errors.push(`[${shot.name}] pageerror: ${e.message}`))

      // 令牌走 fragment —— 与手机扫码进来的路径完全一致。
      await page.goto(`${base}/#t=${token}`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(800)

      // 令牌必须已被从地址栏抹掉：留着会进浏览器历史、被分享、被截图。
      if (page.url().includes(token)) {
        errors.push(`[${shot.name}] 令牌残留在地址栏`)
      }
      // 连接状态条消失 = WebSocket 握手成功。它还在就说明没连上。
      const connBar = await page.locator('.conn-bar').count()
      if (connBar > 0) {
        const txt = await page.locator('.conn-bar').first().textContent()
        errors.push(`[${shot.name}] 未连上：${txt}`)
      }

      await page.screenshot({ path: join(OUT, `${shot.name}.png`) })

      if (shot.width < 820) {
        await page.click('.drawer-toggle').catch(() => {})
        await page.waitForTimeout(400)
        await page.screenshot({ path: join(OUT, `${shot.name}-drawer.png`) })
      } else {
        await page.keyboard.press('Control+k')
        await page.waitForTimeout(350)
        await page.screenshot({ path: join(OUT, `${shot.name}-palette.png`) })
        await page.keyboard.press('Escape')

        // 侧栏面板：文件树和 git 变更各拍一张。
        await page.click('[aria-label="文件"]').catch(() => {})
        await page.waitForTimeout(700)
        await page.screenshot({ path: join(OUT, `${shot.name}-files.png`) })

        await page.click('[aria-label="变更"]').catch(() => {})
        await page.waitForTimeout(900)
        await page.screenshot({ path: join(OUT, `${shot.name}-git.png`) })

        // 手机接入：开局域网监听后应该出二维码。它住在系统设置弹窗里的一个类目下，
        // 不先把弹窗打开就点不到，而点不到时这一步静默失败——
        // 拍出来的 `-pair.png` 会是一张普通会话截图。
        await page.click('[aria-label="变更"]').catch(() => {})
        await page.getByRole('button', { name: '系统设置' }).click()
        await page.getByRole('button', { name: '手机接入' }).click()
        await page.waitForTimeout(500)
        await page
          .locator('.pair-toggle input')
          .check()
          .catch(() => {})
        await page.waitForTimeout(900)
        await page.screenshot({ path: join(OUT, `${shot.name}-pair.png`) })
      }
      await ctx.close()
    }
  } finally {
    await browser.close()
    proc.kill()
  }

  if (errors.length) {
    process.stdout.write('\n问题：\n')
    for (const e of errors) process.stdout.write(`  ✗ ${e}\n`)
    return 1
  }
  process.stdout.write(`\n截图已输出到 ${OUT}\n`)
  return 0
}

process.exit(await main())
