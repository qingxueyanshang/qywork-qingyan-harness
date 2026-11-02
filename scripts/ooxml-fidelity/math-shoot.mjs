#!/usr/bin/env node
/**
 * 公式校准的浏览器驱动：由 `math-calibrate.ts` 启动，参数为页面地址、任务数与输出目录。
 *
 * 用 Node 驱动 Playwright 打开 Edge（`channel: 'msedge'`），设备像素比 1；逐页调用 `renderMathPage` 并对画布截图，
 * 写入 `<输出目录>/page-<序号>.png`（序号自 0 起，与任务顺序一致）。单页失败时记录原因并继续，结束时以失败页数作为退出码。
 */

import { join } from 'node:path'
import { chromium } from 'playwright'

const [base, count, outDir] = process.argv.slice(2)
if (!base || !count || !outDir) {
  console.error('用法：node math-shoot.mjs <页面地址> <任务数> <输出目录>')
  process.exit(2)
}

const browser = await chromium.launch({ channel: 'msedge', headless: true })
let failed = 0
try {
  const context = await browser.newContext({
    deviceScaleFactor: 1,
    viewport: { width: 900, height: 1200 },
  })
  const page = await context.newPage()
  page.on('pageerror', (e) => console.error('页面错误：', e.message))
  await page.goto(base)
  await page.waitForFunction(() => window.pageReady === true)
  for (let i = 0; i < Number(count); i++) {
    try {
      const size = await page.evaluate((n) => window.renderMathPage(n), i)
      if (size === null) continue
      await page.setViewportSize({
        width: Math.max(size.width, 200),
        height: Math.max(size.height, 200),
      })
      await page.locator('#page').screenshot({ path: join(outDir, `page-${i}.png`) })
    } catch (e) {
      failed++
      console.error(`第 ${i} 页失败：${e instanceof Error ? e.message : e}`)
    }
  }
} finally {
  await browser.close()
}
process.exit(failed)
