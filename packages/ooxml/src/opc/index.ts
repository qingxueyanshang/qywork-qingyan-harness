/**
 * OPC 包结构：docx、xlsx、pptx 共用的内容类型、部件关系与部件 XML 扫描。
 *
 * - 典型用法：`openPackage` 打开文件，`relationships('/')` 的 `part('officeDocument')` 取得主文档部件，
 *   再以主文档为源取 `theme`、`styles` 等部件。
 * - 关系类型与命名空间同时识别 Transitional 与 Strict 两套 URI，比较一律使用规范形式。
 * - 部件 XML 用 `PartScanner` 扫描：元素按本地名匹配，不写死前缀；`AlternateContent` 按解析器声明支持的命名空间选择分支。
 */

export { canonicalNamespace, NS, relationshipKind } from './namespace.ts'
export {
  type OpcCorruptReason,
  type OpcFailure,
  type OpcPackage,
  type OpcResult,
  openPackage,
  type Relationship,
  type Relationships,
  resolveTarget,
} from './package.ts'
export { PartScanner } from './scanner.ts'
