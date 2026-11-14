/**
 * 内置宠物「团子」。帧是随应用发布的 SVG，以 data URL 提供，与用户宠物包走同一个渲染组件
 * （`PetSprite`），只是取图方式不同：用户宠物包的帧来自宠物库接口。
 *
 * 不使用 Vite 的 `?url` 资源导入：测试运行时无法解析该后缀，组件测试会在导入时失败。
 */

import type { PetPack } from '@qywork/core'

const BODY_FILL = '#f4f1ea'
const INK = '#2a2a30'
const CHEEK = '#f0a49b'

/** 身体与腮红，各帧共用。眼睛与附加物按帧替换。 */
function frame(face: string, extra = ''): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<ellipse cx="32" cy="58" rx="16" ry="2.6" fill="${INK}" opacity="0.18"/>
<path d="M32 12c13.5 0 22 9.8 22 22.5C54 47 45 55 32 55S10 47 10 34.5C10 21.8 18.5 12 32 12z" fill="${BODY_FILL}" stroke="${INK}" stroke-width="2.2"/>
<ellipse cx="20.5" cy="39" rx="3.6" ry="2.2" fill="${CHEEK}" opacity="0.8"/>
<ellipse cx="43.5" cy="39" rx="3.6" ry="2.2" fill="${CHEEK}" opacity="0.8"/>
${face}${extra}</svg>`
}

const eyes = (dx: number, dy = 0) =>
  `<ellipse cx="${25 + dx}" cy="${32 + dy}" rx="2.4" ry="3.2" fill="${INK}"/><ellipse cx="${39 + dx}" cy="${32 + dy}" rx="2.4" ry="3.2" fill="${INK}"/>`
const smile = `<path d="M28.5 40.5q3.5 3 7 0" fill="none" stroke="${INK}" stroke-width="2" stroke-linecap="round"/>`
const blink = `<path d="M22 32.5h6M36 32.5h6" stroke="${INK}" stroke-width="2.2" stroke-linecap="round"/>`
const happy = `<path d="M22 33q3-4 6 0M36 33q3-4 6 0" fill="none" stroke="${INK}" stroke-width="2.2" stroke-linecap="round"/>`
const open = `<path d="M28 40q4 5 8 0z" fill="${INK}"/>`
const sad = `<path d="M22.5 30.5l5 4M27.5 30.5l-5 4M36.5 30.5l5 4M41.5 30.5l-5 4" stroke="${INK}" stroke-width="2.2" stroke-linecap="round"/><path d="M28.5 42q3.5-3 7 0" fill="none" stroke="${INK}" stroke-width="2" stroke-linecap="round"/>`
const dots = (n: number) =>
  [0, 1, 2]
    .map(
      (i) =>
        `<circle cx="${50 + i * 4.5}" cy="14" r="1.6" fill="${INK}" opacity="${i < n ? 0.85 : 0.2}"/>`,
    )
    .join('')
const cursor = `<path d="M47 36l9 4.2-4 1.1 2.4 4.6-2 1-2.4-4.6-3 2.7z" fill="#ffffff" stroke="${INK}" stroke-width="1.4" stroke-linejoin="round"/>`
const sparkle = `<path d="M52 14v6M49 17h6M12 20v4M10 22h4" stroke="#e8b04a" stroke-width="1.8" stroke-linecap="round"/>`

const SVG: Record<string, string> = {
  'idle.svg': frame(eyes(0) + smile),
  'idle-blink.svg': frame(blink + smile),
  'working-1.svg': frame(eyes(-2, 1) + smile, dots(1)),
  'working-2.svg': frame(eyes(2, 1) + smile, dots(2)),
  'working-3.svg': frame(eyes(0, 1) + smile, dots(3)),
  'desktop.svg': frame(eyes(3, 2) + smile, cursor),
  'done.svg': frame(happy + open, sparkle),
  'failed.svg': frame(sad),
}

export const DANGO_PET: PetPack = {
  name: '团子',
  size: 64,
  states: {
    // 眨眼：五帧中一帧闭眼，每秒 2 帧时每 2.5 秒闭眼 0.5 秒。
    idle: { frames: ['idle.svg', 'idle.svg', 'idle.svg', 'idle.svg', 'idle-blink.svg'], fps: 2 },
    working: { frames: ['working-1.svg', 'working-2.svg', 'working-3.svg'], fps: 3 },
    desktop: { frames: ['desktop.svg'], fps: 1 },
    done: { frames: ['done.svg'], fps: 1 },
    failed: { frames: ['failed.svg'], fps: 1 },
  },
}

/** 「团子」某一帧的地址。 */
export function dangoPetFrame(name: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(SVG[name] ?? '')}`
}
