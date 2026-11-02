#!/usr/bin/env node
/**
 * 候选截图的浏览器驱动：由 `xlsx-candidates.ts` 启动，参数为页面地址与输出目录。
 *
 * 用 Node 驱动 Playwright 打开 Edge（`channel: 'msedge'`），设备像素比 1；逐页以真值清单的区域、位图尺寸与采集时的
 * ClearType 设置调用页面的 `renderPage`，
 * 把视口调整到不小于画布后对画布元素截图，写入 `<输出目录>/<文档标识>/<真值文件名>`。
 * 单页失败时记录原因并继续，结束时以失败页数作为退出码。
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'

const [base, outDir] = process.argv.slice(2)
if (!base || !outDir) {
  console.error('用法：node xlsx-shoot.mjs <页面地址> <输出目录>')
  process.exit(2)
}

const browser = await chromium.launch({ channel: 'msedge', headless: true })
let failed = 0
try {
  const context = await browser.newContext({
    deviceScaleFactor: 1,
    viewport: { width: 1600, height: 1200 },
  })
  const page = await context.newPage()
  page.on('pageerror', (e) => console.error('页面错误：', e.message))
  await page.goto(base)
  await page.waitForFunction(() => window.pageReady === true)
  const jobs = await (await fetch(new URL('/jobs', base))).json()
  for (const job of jobs) {
    await mkdir(join(outDir, job.id), { recursive: true })
    for (const p of job.pages) {
      const started = Date.now()
      try {
        const size = await page.evaluate(
          ([id, sheet, range, width, height, clearType]) =>
            window.renderPage(id, sheet, range, width, height, clearType),
          [job.id, p.sheet, p.range, p.width, p.height, job.clearType],
        )
        await page.setViewportSize({
          width: Math.max(size.width, 200),
          height: Math.max(size.height, 200),
        })
        await page.locator('#sheet').screenshot({ path: join(outDir, job.id, p.file) })
        const { region } = size
        const differs = region.width !== size.width || region.height !== size.height
        console.log(
          `${job.id} ${p.file} ${p.sheet} ${size.width}×${size.height}` +
            `${differs ? `（本方区域 ${region.width}×${region.height}）` : ''} ${Date.now() - started}ms`,
        )
      } catch (e) {
        failed++
        console.error(`${job.id} ${p.file} ${p.sheet} 失败：${e instanceof Error ? e.message : e}`)
      }
    }
  }
} finally {
  await browser.close()
}
process.exit(failed)
