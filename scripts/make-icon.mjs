#!/usr/bin/env node
/**
 * 生成应用图标源图（1024×1024 PNG），再交给 `tauri icon` 派生各平台尺寸。
 *
 * 用浏览器渲染 SVG 而不是引一个图像库：Playwright 本来就在依赖里（截图验证用），
 * 而它的光栅化质量和最终 WebView 里的一致——图标和界面出自同一个渲染器。
 * 必须用 node 启动，Bun 驱动不了 Playwright。
 *
 *   node scripts/make-icon.mjs
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, '.tmp', 'icon', 'source.png')

/*
 * 标识：圆角方块里的终端提示符 `>QY`。笔画端点全部 round，与界面图标集同一套规则
 * （24 网格、圆端点）。深底浅字：小尺寸下（任务栏 16px）实心底比线稿更容易辨认。
 *
 * QY 两个字母用描边路径画，不用 <text>：字体是本机资源，换台机器渲染出的字形不同，
 * 图标就跟着变。Q 是整圆加一段尾巴，Y 是两条斜臂加一根竖干。
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
  <g stroke="#f2f2f4" stroke-width="56" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M202 400 L294 512 L202 624"/>
    <circle cx="486" cy="512" r="92"/>
    <path d="M546 572 L598 624"/>
    <path d="M670 420 L746 512 L822 420"/>
    <path d="M746 512 L746 604"/>
  </g>
</svg>`

async function main() {
  const browser = await chromium.launch()
  let png
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } })
    await page.setContent(`<body style="margin:0;background:transparent">${SVG}</body>`, {
      waitUntil: 'load',
    })
    png = await page.screenshot({ omitBackground: true })
  } finally {
    await browser.close()
  }

  await mkdir(dirname(OUT), { recursive: true })
  await writeFile(OUT, png)
  process.stdout.write(`图标源图已生成：${OUT}\n`)
}

await main()
