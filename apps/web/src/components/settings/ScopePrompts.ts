import type { Scope } from '../../lib/store/index.ts'

function selected(scope: Scope): string {
  return scope === 'global' ? '全局层（global）' : '项目层（project）'
}

export function newMemoryPrompt(scope: Scope): string {
  return (
    `当前设置页选择的是${selected(scope)}。为该作用域添加一条记忆。` +
    '先说明记忆在 qywork 中的工作方式、分为哪几层、写入哪个目录；然后询问用户要记录的内容。' +
    `最终写入必须调用 write_memory 并明确传入 scope=${scope}。` +
    '若用户要迁移已有记忆，必须调用 move_memory 完成迁移，迁移成功后不能在两个作用域中同时保留。'
  )
}

export function newSkillPrompt(scope: Scope): string {
  return (
    `当前设置页选择的是${selected(scope)}。为该作用域创建一个技能。` +
    '先说明技能在 qywork 中如何被索引、何时被加载，以及目录与 SKILL.md 的结构；' +
    '然后询问用户该技能的用途、分为几步。' +
    `创建技能必须调用 write_skill 并明确传入 scope=${scope}。安装现有目录或 ZIP 必须使用 import_skill 并传入同一 scope，以扫描读取的结果确认生效。` +
    '若用户要迁移已有技能，必须调用 move_skill 完成迁移，迁移成功后不能在两个作用域中同时保留。'
  )
}

export function newMcpPrompt(scope: Scope): string {
  return (
    `当前设置页选择的是${selected(scope)}。为该作用域接入一个 MCP 服务。` +
    '先说明 MCP 服务在 qywork 中如何配置与连接，配置写在哪个文件；' +
    '然后询问用户要接入哪一个服务、使用本机命令还是 HTTP。' +
    `最终写入必须调用 write_mcp_server 并明确传入 scope=${scope}。` +
    '若用户要迁移已有服务，必须调用 move_mcp_server 完成迁移，迁移成功后不能在两个作用域中同时保留。'
  )
}
