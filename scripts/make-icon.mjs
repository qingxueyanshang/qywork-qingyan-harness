#!/usr/bin/env node
/**
 * 生成应用图标源图（1024×1024 PNG），再交给 `tauri icon` 派生各平台尺寸。
 *
 * 用浏览器渲染 SVG 而不是引一个图像库：Playwright 本来就在依赖里（截图验证用），
 * 而它的光栅化质量和最终 WebView 里的一致——图标和界面出自同一个渲染器。
 *
 *   node scripts/make-icon.mjs
 */

import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'apps/desktop/src-tauri/icons/source.png')

/*
 * 标识：一个圆角方块里的「>_」终端提示符，笔画端点全部 round。
 * 与界面图标集同一套规则（24 网格、圆端点），所以放在一起不打架。
 * 深底浅字：小尺寸下（任务栏 16px）实心底比线稿更容易辨认。
 */
const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#2b2b31"/>
      <stop offset="100%" stop-color="#141417"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="1024" height="1024" rx="228" fill="url(#bg)"/>
  <g stroke="#f2f2f4" stroke-width="64" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M330 372 L470 512 L330 652"/>
    <path d="M556 664 L706 664"/>
  </g>
</svg>`

async function main() {
  await mkdir(dirname(OUT), { recursive: true })
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } })
    await page.setContent(`<body style="margin:0;background:transparent">${SVG}</body>`, {
      waitUntil: 'load',
    })
    await page.screenshot({ path: OUT, omitBackground: true })
  } finally {
    await browser.close()
  }
  process.stdout.write(`图标源图已生成：${OUT}\n`)
}

await main()
