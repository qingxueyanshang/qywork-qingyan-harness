#!/usr/bin/env node
/**
 * 附件链路的界面检查：粘贴 / 拖入 → chip 与缩略图 → 落盘位置 → 删除会话后清理目录。
 *
 * **本脚本的用途。** 该链路中**有四项行为 `bun test` 无法覆盖**：浏览器的粘贴与拖放事件、
 * 跨源预检、CSS 固定尺寸，以及「附件目录随会话一起删除」这一跨进程副作用。
 * 这四项出错时都不报错：粘贴之后无任何反应、缩略图撑高所在行、
 * 目录残留在磁盘上，只能通过人工检查发现。
 *
 * 装配方式与 `shoot-ui.mjs` 相同：**Node 驱动 Playwright、Bun 启动服务**。Bun 在 Windows 上
 * 对 `--remote-debugging-pipe` 的 fd 3/4 支持不完整，`chromium.launch()` 会阻塞直至超时。
 *
 * **无法驱动的两项。** 桌面外壳的拖放（`tauri://drag-drop`）与原生多选（`pick_files`）**只在 Tauri
 * 中存在**，Playwright 驱动的是浏览器，不会触发这两个事件。验证这两项需要启动桌面应用
 * 手动操作一次。本脚本覆盖浏览器路径，它也是手机端唯一的路径。
 *
 *   node scripts/check-attachments.mjs
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WS = join(ROOT, '.tmp', 'attach-ws')

/** 1×1 的 PNG，体积小且是有效图片：`isInlineImage` 按扩展名判定，内容只需能够解码。 */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

let failed = 0
const ok = (m) => console.log(`  ✓ ${m}`)
const bad = (m) => {
  failed++
  console.log(`  ✗ ${m}`)
}

async function startServer() {
  await rm(WS, { recursive: true, force: true })
  await mkdir(WS, { recursive: true })
  await writeFile(join(WS, 'README.md'), '# demo\n', 'utf8')
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
      WS,
      '--static',
      join(ROOT, 'apps/web/dist'),
      '--print-token',
      // Windows 上 shell:true 时 proc 是 cmd.exe，kill 终止的是 shell 进程而不是 bun。
      '--parent-pid',
      String(process.pid),
    ],
    {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      // 配置与账本一并指向临时目录：附件保存在该目录下，检查才有可核对的内容。
      env: { ...process.env, QYWORK_HOME: WS },
    },
  )
  return new Promise((resolve, reject) => {
    let token = null
    let port = null
    let buf = ''
    const timer = setTimeout(() => reject(new Error('serve 启动超时')), 30_000)
    proc.stdout.on('data', (c) => {
      buf += c.toString()
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

/** 将一张 PNG 构造为 `File`，按 `how` 执行粘贴或拖放。两种方式都必须使用浏览器的真实事件。 */
function feed(page, how, name) {
  return page.evaluate(
    ([b64, kind, fileName]) => {
      const bin = atob(b64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const dt = new DataTransfer()
      dt.items.add(new File([bytes], fileName, { type: 'image/png' }))
      const ta = document.querySelector('.composer-input')
      const ev =
        kind === 'paste'
          ? new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
          : new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
      ta.dispatchEvent(ev)
    },
    [PNG, how, name],
  )
}

const hard = setTimeout(() => {
  console.log('  ✗ 整体超时')
  process.exit(1)
}, 120_000)
hard.unref?.()

const { proc, token, port } = await startServer()
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.on('pageerror', (e) => bad(`页面抛异常：${e.message.slice(0, 120)}`))

  // 令牌经由 fragment 传递，与手机扫码进入的路径一致。
  // **不使用 `networkidle`**：WebSocket 是常驻连接，该条件永远不会满足，
  // 脚本会静默阻塞直至超时。
  await page.goto(`http://127.0.0.1:${port}/#t=${token}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.composer-input', { timeout: 20_000 })
  await page.waitForTimeout(1200)
  if ((await page.locator('.conn-bar').count()) > 0) {
    bad(`没连上：${await page.locator('.conn-bar').first().textContent()}`)
  } else ok('页面起来了，WebSocket 已连上')

  // ── 粘贴 ──
  // 该步骤同时验证 CORS 预检：`x-attachment-name` 不在允许列表中时，
  // 上传请求不会发出，chip 不会出现（仅报 Failed to fetch）。
  await feed(page, 'paste', 'image.png')
  await page.waitForSelector('.attach-chip', { timeout: 15_000 })
  ok('粘贴：chip 出现（同时验证预检放行 x-attachment-name）')

  // ── 拖入（浏览器路径；桌面外壳经由 tauri://drag-drop，此处无法驱动）──
  await feed(page, 'drop', 'dropped.png')
  await page.waitForFunction(() => document.querySelectorAll('.attach-chip').length >= 2, {
    timeout: 15_000,
  })
  ok('拖入：第二个 chip 出现')

  const names = await page.locator('.attach-chip .truncate').allInnerTexts()
  const shown = names.map((n) => n.trim()).filter(Boolean)
  if (shown.length === 2) ok(`两个 chip 各有名字：${shown.join(' / ')}`)
  else bad(`chip 名字只渲染出 ${shown.length} 个：${JSON.stringify(names)}`)

  // ── 固定尺寸（B9：尺寸不随内容变化）──
  const thumbs = await page.locator('.attach-chip .attach-thumb').all()
  if (thumbs.length < 2) bad(`缩略图格子只有 ${thumbs.length} 个`)
  const boxes = await Promise.all(thumbs.map((t) => t.boundingBox()))
  if (boxes.every((b) => b && Math.round(b.width) === 20 && Math.round(b.height) === 20)) {
    ok('待发缩略图都是 20×20 定尺')
  } else bad(`缩略图尺寸不齐：${JSON.stringify(boxes)}`)

  const imgs = await page.locator('.attach-chip .attach-thumb img').count()
  if (imgs === 2) ok('两个格子里都是真图，不是占位图标')
  else bad(`只有 ${imgs} 个格子渲染出了图`)

  // ── 发送 ──
  // 乐观插入先把带附件的用户消息加入会话流，不等待服务端回执。
  // 因此即使该工作区未配置可用的模型、本轮无法运行，这部分渲染仍可验证。
  await page.locator('.composer-input').fill('看这两张图')
  await page.locator('.composer-input').press('Enter')
  await page.waitForSelector('.attach-row.sent .attach-chip', { timeout: 15_000 })
  ok('发送：会话流里出现带附件的用户消息')

  const sentBox = await page.locator('.attach-row.sent .attach-thumb').first().boundingBox()
  if (sentBox && Math.round(sentBox.width) === 44) ok('会话流里的缩略图是 44×44 定尺')
  else bad(`会话流缩略图尺寸不对：${JSON.stringify(sentBox)}`)

  // ── 落盘位置 ──
  const dir = join(WS, 'attachments')
  if (!existsSync(dir)) {
    bad('附件没有落在 QYWORK_HOME/attachments/')
  } else {
    const cids = readdirSync(dir)
    const cid = cids[0]
    ok(`落点 QYWORK_HOME/attachments/${cid}/ —— 与会话库同一棵树`)
    ok(`目录内容：${readdirSync(join(dir, cid)).join(', ')}`)
    if (existsSync(join(WS, '.qy', 'attachments'))) bad('工作区里仍然被创建了 .qy/attachments')
    else ok('工作区里没有 .qy/attachments（旧落点已废弃）')

    // ── 删除会话 → 目录随之删除 ──
    const status = await page.evaluate(
      async ([p, t, id]) => {
        const r = await fetch(`http://127.0.0.1:${p}/api/conversations/${id}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${t}` },
        })
        return r.status
      },
      [port, token, cid],
    )
    if (status !== 200) bad(`删会话回了 ${status}`)
    else if (existsSync(join(dir, cid))) bad('删会话之后附件目录还在')
    else ok('删会话之后附件目录跟着没了')
  }
} finally {
  clearTimeout(hard)
  await browser.close()
  proc.kill()
  await rm(WS, { recursive: true, force: true }).catch(() => {})
}

console.log(failed === 0 ? '\n附件链路：全绿' : `\n附件链路：${failed} 项没过`)
process.exit(failed === 0 ? 0 : 1)
