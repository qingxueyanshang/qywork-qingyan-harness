/**
 * 设置页角色表单的保存规则。表单只有五格，角色还有表单上没有的字段（provider、effort、allowedTools）：
 * 保存时以原对象为底只覆盖表单里的字段；模型清空时 provider 一并去掉，它只对一个模型成立。
 */

export interface RoleForm {
  id: string
  name: string
  description: string
  systemPrompt: string
  model: string
}

export function nextRole<T extends { provider?: string; model?: string }>(
  existing: T | undefined,
  f: RoleForm,
): Omit<T, 'provider' | 'model'> & {
  id: string
  name: string
  description: string
  systemPrompt: string
  provider?: string
  model?: string
} {
  const { model: _model, provider, ...keep } = existing ?? ({} as T)
  const model = f.model.trim()
  return {
    ...keep,
    id: f.id.trim(),
    name: f.name.trim() || f.id.trim(),
    description: f.description.trim(),
    systemPrompt: f.systemPrompt,
    ...(model ? { model, ...(provider ? { provider } : {}) } : {}),
  }
}
