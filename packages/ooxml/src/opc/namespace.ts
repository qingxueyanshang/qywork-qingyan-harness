/**
 * 命名空间与关系类型的规范形式。
 *
 * - Strict 文档的命名空间与关系类型以 `http://purl.oclc.org/ooxml/` 开头，比较前一律换算为 Transitional 形式：
 *   `http://purl.oclc.org/ooxml/<领域>/<其余>` 对应 `http://schemas.openxmlformats.org/<领域>/2006/<其余>`。
 * - 包层命名空间（内容类型、关系部件、核心属性）与标记兼容性命名空间在两套规范中相同，不换算。
 * - 内容类型在两套规范中相同，不需要换算。
 */

const STRICT_PREFIX = 'http://purl.oclc.org/ooxml/'
const TRANSITIONAL_PREFIX = 'http://schemas.openxmlformats.org/'
const OFFICE_RELATIONSHIP_PREFIX =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'

/** 常用命名空间的规范形式。 */
export const NS = {
  markupCompatibility: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  /** `r:id`、`r:embed` 等关系引用属性所在的命名空间。 */
  relationships: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
} as const

/** 把 Strict URI 换算为对应的 Transitional URI；其他 URI 原样返回。命名空间与关系类型共用这一规则。 */
export function canonicalNamespace(uri: string): string {
  if (!uri.startsWith(STRICT_PREFIX)) return uri
  const rest = uri.slice(STRICT_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash < 0) return uri
  return `${TRANSITIONAL_PREFIX}${rest.slice(0, slash)}/2006${rest.slice(slash)}`
}

/**
 * 关系类型的简称：officeDocument 关系命名空间下的类型（两套规范）取末段，如 `officeDocument`、`theme`、
 * `styles`、`worksheet`；其他类型（包层关系、各厂商的扩展关系）返回规范形式的完整 URI。
 */
export function relationshipKind(type: string): string {
  const canonical = canonicalNamespace(type)
  return canonical.startsWith(OFFICE_RELATIONSHIP_PREFIX)
    ? canonical.slice(OFFICE_RELATIONSHIP_PREFIX.length)
    : canonical
}
