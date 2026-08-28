import type { Scope } from '../../lib/store/index.ts'

function selected(scope: Scope): string {
  return scope === 'global' ? '全局层（global）' : '项目层（project）'
}

export function newMemoryPrompt(scope: Scope): string {
  return (
    `当前设置页选择的是${selected(scope)}。我们一起来加一条记忆吧。` +
    '先说明记忆在 qywork 里怎么工作、分哪几层、写在哪个目录；然后问我要记什么。' +
    `最终写入必须调用 write_memory 并明确传 scope=${scope}。` +
    '如果我要迁移已有记忆，必须调用 move_memory 完成迁移，成功后不能在两个作用域各留一份。'
  )
}

export function newSkillPrompt(scope: Scope): string {
  return (
    `当前设置页选择的是${selected(scope)}。我们一起来做一个技能吧。` +
    '先说明技能在 qywork 里怎么被索引、什么时候会被加载，目录和 SKILL.md 长什么样；' +
    '然后问我这个技能要干什么、分几步。' +
    `最终写入必须调用 write_skill 并明确传 scope=${scope}。` +
    '如果我要迁移已有技能，必须调用 move_skill 完成迁移，成功后不能在两个作用域各留一份。'
  )
}

export function newMcpPrompt(scope: Scope): string {
  return (
    `当前设置页选择的是${selected(scope)}。我们一起来接一个 MCP 服务吧。` +
    '先说明 MCP 服务在 qywork 里怎么配置、连接，配置写在哪个文件；' +
    '然后问我要接哪一个、走本机命令还是 HTTP。' +
    `最终写入必须调用 write_mcp_server 并明确传 scope=${scope}。` +
    '如果我要迁移已有服务，必须调用 move_mcp_server 完成迁移，成功后不能在两个作用域各留一份。'
  )
}
