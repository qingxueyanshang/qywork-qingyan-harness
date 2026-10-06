#!/usr/bin/env node
/**
 * 界面截图验证。
 *
 * 用 Node 而不是 Bun 驱动 Playwright：Bun 在 Windows 上对 `--remote-debugging-pipe`
 * 使用的 fd 3/4 管道支持不完整，`chromium.launch()` 会阻塞直至超时。因此分工如下：
 * Node 驱动浏览器，Bun 运行服务，各自负责运行稳定的部分。
 *
 * 同时验证真实发布路径：脚本启动的是 `qy serve --static`（静态托管构建产物），
 * 与开发时的 Vite 代理不是同一路径，不测试该路径就无法验证发布版本。
 *
 *   node scripts/shoot-ui.mjs
 */

import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WS_DIR = join(ROOT, '.tmp', 'shoot-ws')
const OUT = join(ROOT, '.tmp', 'shots')

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

  // 初始化为真实 git 仓库并保留未提交改动，否则 git 面板只能截取到「不是 git 仓库」。
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

  // QYWORK_HOME 将配置与账本一并指向临时目录：既不污染用户的真实账本，
  // 也保证种子数据与 serve 读取同一个库（config.dataPath() 位于该目录下）。
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
      // Windows 上 shell:true 时 proc 是 cmd.exe，proc.kill() 结束的是 shell 而不是 bun，
      // 遗留的服务持有 SQLite 的 WAL 锁，下次运行本脚本会在 rm 工作区时报 EBUSY。
      // 由服务自行监视父进程，与 Tauri sidecar 采用同一机制。
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

/**
 * 打开右侧面板并切换到指定页签。
 *
 * 页签是带文字的 `role="tab"`，没有 `aria-label`；面板默认折叠，不先展开
 * 则无法点击任何页签。任一条件不成立时切换会静默失败，截取的是
 * 上一张截图的界面，因此点击失败时必须在 `errors` 中记录一条，不能静默忽略。
 */
async function openPanelTab(page, label) {
  const expand = page.locator('[aria-label="展开侧面板"]')
  if (await expand.count()) await expand.click()
  await page.getByRole('tab', { name: label, exact: true }).click()
}

async function main() {
  await mkdir(OUT, { recursive: true })
  const { proc, token, port } = await startServer()
  const base = `http://127.0.0.1:${port}`
  process.stdout.write(`服务已启动：${base}\n`)

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

      // 令牌经 URL fragment 传递，与手机扫码接入的路径一致。
      await page.goto(`${base}/#t=${token}`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(800)

      // 令牌必须已从地址栏清除：保留时会进入浏览器历史，并可能被分享或截图。
      if (page.url().includes(token)) {
        errors.push(`[${shot.name}] 令牌残留在地址栏`)
      }
      // 连接状态条消失表示 WebSocket 握手成功；仍显示则说明未连接。
      const connBar = await page.locator('.conn-bar').count()
      if (connBar > 0) {
        const txt = await page.locator('.conn-bar').first().textContent()
        errors.push(`[${shot.name}] 未连接：${txt}`)
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

        // 侧栏面板：文件树与 git 变更各截取一张。
        await openPanelTab(page, '文件').catch((e) =>
          errors.push(`[${shot.name}] 无法切换到文件页：${e.message}`),
        )
        await page.waitForTimeout(700)
        await page.screenshot({ path: join(OUT, `${shot.name}-files.png`) })

        await openPanelTab(page, '变更').catch((e) =>
          errors.push(`[${shot.name}] 无法切换到变更页：${e.message}`),
        )
        await page.waitForTimeout(900)
        await page.screenshot({ path: join(OUT, `${shot.name}-git.png`) })

        // 手机接入：开启局域网监听后应显示二维码。它是系统设置弹窗「通用」页中的
        // 一个区块，不是类目，按类目查找无法定位。定位失败时该步骤静默失败，
        // 截取的 `-pair.png` 会是一张普通会话截图，因此失败必须记入 `errors`。
        await page.getByRole('button', { name: '系统设置' }).click()
        await page.getByRole('button', { name: '通用', exact: true }).click()
        await page.waitForTimeout(500)
        await page
          .locator('.pair-toggle input')
          .check()
          .catch((e) => errors.push(`[${shot.name}] 无法开启局域网监听：${e.message}`))
        await page.waitForTimeout(900)
        // 手机接入是「通用」页的最后一个区块，不滚动到该处时截取的是页首的外观设置。
        await page
          .locator('.pair-qr')
          .scrollIntoViewIfNeeded()
          .catch((e) => errors.push(`[${shot.name}] 未显示二维码：${e.message}`))
        await page.waitForTimeout(300)
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
