/**
 * SmartArt 绘制：在图示框中排版（`layout.ts`），再把每个形状按自选图形绘制（`../shape/paint.ts`）。
 *
 * - 图示框的旋转与翻转按组合处理：以框中心为原点作用于全部形状。
 * - 字号适配使用与绘制相同的文字排版（`layoutBody`），单词被强制断开的判定见 `measureText`。
 * - 没有可用字体（`ShapeScene.settings` 为 `null`）时不适配字号，也不绘制文字。
 */

import type { Matrix } from '../paint/context.ts'
import type { Frame } from '../shape/model.ts'
import { groupMatrix, paintAutoShape, type ShapeScene } from '../shape/paint.ts'
import { layoutBody, type TextSettings } from '../text/body.ts'
import type { TextBody } from '../text/model.ts'
import { layoutDiagram } from './layout.ts'
import type { Diagram } from './model.ts'

const WORD = /[A-Za-z0-9]/

/**
 * 文字在 `width` 磅宽内的内容高度。非强制换行的行尾两侧都是字母或数字时，该行在单词中间断开：
 * 单词超出行宽时排版模块在超出处强制断开，行宽不会超出。
 */
export function measureText(
  text: TextBody,
  width: number,
  settings: TextSettings,
): { height: number; broken: boolean } {
  const layout = layoutBody(text, width, settings)
  let broken = false
  for (const p of layout.paragraphs) {
    const chars = p.runs.map((r) => r.text).join('')
    const lines = p.block.lines
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i]
      if (line === undefined || line.forcedBreak) continue
      if (WORD.test(chars[line.end - 1] ?? '') && WORD.test(chars[line.end] ?? '')) broken = true
    }
  }
  return { height: layout.height, broken }
}

export function paintDiagram(
  scene: ShapeScene,
  diagram: Diagram,
  frame: Frame,
  parent: Matrix,
): void {
  const settings = scene.settings
  const shapes = layoutDiagram(
    diagram,
    frame.width,
    frame.height,
    settings === null ? null : (text, width) => measureText(text, width, settings),
  )
  const inner = groupMatrix(frame, parent)
  for (const s of shapes) {
    scene.ctx.save()
    paintAutoShape(
      scene,
      {
        frame: {
          x: frame.x + s.x,
          y: frame.y + s.y,
          width: s.width,
          height: s.height,
          rotation: s.rotation,
          flipH: false,
          flipV: false,
        },
        geometry: s.geometry,
        fill: s.fill,
        line: s.line,
        effects: s.effects,
        text: s.text,
      },
      inner,
    )
    scene.ctx.restore()
  }
}
