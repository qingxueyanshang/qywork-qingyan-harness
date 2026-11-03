/**
 * 文字排版：PPT 文本框与 Word 段落共用的字体选择、断行、对齐与行高。
 *
 * - `fontSlot` 按码位在字段的四种字体中选择；`layoutParagraph` 输出带坐标的行、片段与行内对象。
 * - 宽度与行高均由字体文件计算（`../font`），调用方负责按字体名找到字体文件并读取度量；主机没有的字体名按 Windows 字体替换表
 *   替换的结果见 `windowsFontSubstitute`，按主机字体族名的前缀匹配见 `prefixFont`。
 */

export {
  type BreakRules,
  canBreakBetween,
  canBreakForWidth,
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
  type HostFamilies,
  NO_HOST_FAMILIES,
  prefixFont,
  windowsFontSubstitute,
} from './font-substitutes.ts'
export {
  type Alignment,
  contentWidths,
  emboldened,
  type InlineObject,
  type LineArea,
  type LineLeader,
  type LineObject,
  layoutParagraph,
  type ObjectRun,
  PARAGRAPH_DEFAULTS,
  type ParagraphRun,
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
export {
  WPS_METRIC_FONTS,
  type WpsMetricFont,
  wpsEmfFaces,
  wpsExtentFace,
  wpsMetricFace,
  wpsMetricFontNames,
} from './wps-fonts.ts'
