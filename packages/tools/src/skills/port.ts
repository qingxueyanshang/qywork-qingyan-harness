import { definePort } from '@qywork/agent'

/**
 * 当前会话已绑定的技能包来源，精确到附件路径。`import_skill` 的来源在其中时直接读取，
 * 否则按工作区路径边界解析；未注入时一律按后者处理。
 */
export type SkillSourcePaths = () => string[]

export const SkillSourcePaths = definePort<SkillSourcePaths>('skillSourcePaths')
