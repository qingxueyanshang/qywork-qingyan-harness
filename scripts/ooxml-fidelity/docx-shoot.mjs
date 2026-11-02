#!/usr/bin/env node
/**
 * docx 候选截图的浏览器驱动：由 `docx-candidates.ts` 启动，参数为页面地址与输出目录。
 *
 * 用 Node 驱动 Playwright 打开 Edge（`channel: 'msedge'`），设备像素比 1；逐页调用页面的 `renderPage`，
 * 把视口调整到不小于画布后对画布元素截图，写入 `<输出目录>/<文档标识>/<真值文件名>`。本方没有的页不输出。
 * 每个文档另写 `pages.json`（本方页数与每页的表格、浮动对象、图表、SmartArt、绘制与未绘制的公式个数）。单页失败时记录原因并继续，结束时以失败页数作为退出码。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'

const [base, outDir] = process.argv.slice(2)
if (!base || !outDir) {
  console.error('用法：node docx-shoot.mjs <页面地址> <输出目录>')
  process.exit(2)
}

const browser = await chromium.launch({ channel: 'msedge', headless: true })
let failed = 0
try {
  const context = await browser.newContext({
    deviceScaleFactor: 1,
    viewport: { width: 1200, height: 1400 },
  })
  const page = await context.newPage()
  page.on('pageerror', (e) => console.error('页面错误：', e.message))
  await page.goto(base)
  await page.waitForFunction(() => window.pageReady === true)
  const jobs = await (await fetch(new URL('/jobs', base))).json()
  for (const job of jobs) {
    await mkdir(join(outDir, job.id), { recursive: true })
    const stats = { pages: 0, perPage: [] }
    for (const p of job.pages) {
      const started = Date.now()
      try {
        const info = await page.evaluate(
          ([id, n, w, h]) => window.renderPage(id, n, w, h),
          [job.id, p.n, p.width, p.height],
        )
        if (info === null) continue
        stats.pages = info.pages
        stats.perPage.push({
          n: p.n,
          tables: info.tables,
          floating: info.floating,
          charts: info.charts,
          diagrams: info.diagrams,
          formulas: info.formulas,
          hiddenMath: info.hiddenMath,
        })
        await page.setViewportSize({
          width: Math.max(p.width, 200),
          height: Math.max(p.height, 200),
        })
        await page.locator('#page').screenshot({ path: join(outDir, job.id, p.file) })
        console.log(`${job.id} ${p.file} ${p.width}×${p.height} ${Date.now() - started}ms`)
      } catch (e) {
        failed++
        console.error(`${job.id} ${p.file} 失败：${e instanceof Error ? e.message : e}`)
      }
    }
    await writeFile(join(outDir, job.id, 'pages.json'), JSON.stringify(stats, null, 1))
  }
} finally {
  await browser.close()
}
process.exit(failed)
