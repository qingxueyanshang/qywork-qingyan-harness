#!/usr/bin/env node
/**
 * pptx 候选截图的浏览器驱动：由 `pptx-candidates.ts` 启动，参数为页面地址与输出目录。
 *
 * 用 Node 驱动 Playwright 打开 Edge（`channel: 'msedge'`），设备像素比 1；逐页调用页面的
 * `renderPage(id, slide, width, height, clearType, date)`，把视口调整到不小于画布后对画布元素截图，
 * 写入 `<输出目录>/<文档标识>/<真值文件名>`。单页失败时记录原因并继续，结束时以失败页数作为退出码。
 *
 * 画布由 CPU 光栅化（`--disable-accelerated-2d-canvas`）：GPU 光栅化时抗锯齿字形边缘的像素在不同的浏览器进程之间
 * 相差 1 个色阶（同一进程内重复绘制不变），候选图因此每次运行不同，对照无法逐字节比较。
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'

const [base, outDir] = process.argv.slice(2)
if (!base || !outDir) {
  console.error('用法：node pptx-shoot.mjs <页面地址> <输出目录>')
  process.exit(2)
}

const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: ['--disable-accelerated-2d-canvas'],
})
let failed = 0
try {
  const context = await browser.newContext({
    deviceScaleFactor: 1,
    viewport: { width: 1600, height: 1200 },
  })
  const page = await context.newPage()
  page.on('pageerror', (e) => console.error('页面错误：', e.message))
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.error('页面输出：', m.text())
  })
  await page.goto(base)
  await page.waitForFunction(() => window.pageReady === true)
  const jobs = await (await fetch(new URL('/jobs', base))).json()
  for (const job of jobs) {
    await mkdir(join(outDir, job.id), { recursive: true })
    for (const p of job.pages) {
      const started = Date.now()
      try {
        const size = await page.evaluate(
          ([id, slide, width, height, clearType, date]) =>
            window.renderPage(id, slide, width, height, clearType, date),
          [job.id, p.slide, p.width, p.height, job.clearType, job.date],
        )
        await page.setViewportSize({
          width: Math.max(size.width, 200),
          height: Math.max(size.height, 200),
        })
        await page.locator('#slide').screenshot({ path: join(outDir, job.id, p.file) })
        console.log(
          `${job.id} ${p.file} 第 ${p.slide} 张 ${size.width}×${size.height} ${Date.now() - started}ms`,
        )
      } catch (e) {
        failed++
        console.error(
          `${job.id} ${p.file} 第 ${p.slide} 张 失败：${e instanceof Error ? e.message : e}`,
        )
      }
    }
  }
} finally {
  await browser.close()
}
process.exit(failed)
