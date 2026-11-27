/**
 * 技能目录中 `SKILL.md` 的前置元信息。电脑端扫描与安装技能、云端列出内置技能都经由本文件解析，
 * 两侧对同一个 `SKILL.md` 给出相同的名称与描述。
 */

/**
 * 解析 YAML 前置元信息。
 *
 * 只识别 `name` 和 `description` 两个标量键，不引入 YAML 库：技能元信息只有这两个字段，
 * 为此引入解析器（及其攻击面）得不偿失。其他键会被忽略：
 * 此处保持宽松，将来增加字段时旧技能不会因此报错。
 */
export function parseSkillFrontmatter(text: string): { name: string; description: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!m) return { name: '', description: '' }

  const out = { name: '', description: '' }
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^\s*(name|description)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    let value = kv[2]!.trim()
    // 去除可选的引号。不支持 YAML 多行标量：技能描述是一句话，需要多行说明时写在正文中。
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[kv[1] as 'name' | 'description'] = value
  }
  return out
}

/**
 * description 能否作为技能索引的一行：非空，且不是 YAML 多行标量的引导符（`|`、`>-` 等）。
 * description 是模型判断何时使用该技能的唯一依据，不满足时该技能不会被使用。
 */
export function isSkillDescription(description: string): boolean {
  return description !== '' && !/^[|>][+-]?\d?$/.test(description)
}
