/**
 * 文字排版：PPT 文本框与 Word 段落共用的字体选择、断行、对齐与行高。
 *
 * - `fontSlot` 按码位在字段的四种字体中选择；`layoutParagraph` 输出带坐标的行与片段。
 * - 宽度与行高均由字体文件计算（`../font`），调用方负责按字体名找到字体文件并读取度量。
 */

export {
  type BreakRules,
  canBreakBetween,
  codePointSet,
  DEFAULT_NO_LINE_BREAK_AFTER,
  DEFAULT_NO_LINE_BREAK_BEFORE,
  HANGING_PUNCTUATION,
} from './breaking.ts'
export {
  DEFAULT_SLOT_CONTEXT,
  type FontSlot,
  fontSlot,
  isEastAsian,
  isIdeographic,
  type SlotContext,
} from './classify.ts'
export {
  type Alignment,
  emboldened,
  type LineArea,
  layoutParagraph,
  PARAGRAPH_DEFAULTS,
  type ParagraphStyle,
  type RunFonts,
  type TabStop,
  type TextBlock,
  type TextFace,
  type TextFragment,
  type TextLine,
  type TextRun,
} from './layout.ts'
export {
  type FaceExtent,
  faceExtent,
  type LineBox,
  type LineSpacing,
  lineBox,
  singleLineHeight,
} from './line-height.ts'
