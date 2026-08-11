# 文档索引

四份主文档在仓库根，各管一段（分工规则见 [`../CLAUDE.md`](../CLAUDE.md) D1）：

| 文件 | 写什么 |
|---|---|
| [`../README.md`](../README.md) | 对外用法：怎么装、怎么跑、配置长什么样 |
| [`../ARCHITECTURE.md`](../ARCHITECTURE.md) | 为什么这么做，每条附实测数据或踩坑记录 |
| [`../ROADMAP.md`](../ROADMAP.md) | §1–§39 的历史方案与执行记录（§40 起改写进 `plans/`） |
| [`../CLAUDE.md`](../CLAUDE.md) | 开发规则 |

## 子系统说明

| 文件 | 写什么 |
|---|---|
| [`permissions.md`](permissions.md) | 权限两模式、裁决三层、内核沙箱与已知边界 |
| [`plugins.md`](plugins.md) | 写一个插件：清单、RPC 协议、宿主能力与权限边界 |
| [`mcp.md`](mcp.md) | 接外部 MCP server：配置、权限、限制 |
| [`team.md`](team.md) | 多角色编排：后端、角色、计划、规则 |

## 计划

[`plans/INDEX.md`](plans/INDEX.md) —— 在办与已归档的计划。
每份计划自带执行进度看板，格式与回写纪律见 [`../CLAUDE.md`](../CLAUDE.md) A3。

## 项目记忆

[`../.claude/memory/MEMORY.md`](../.claude/memory/MEMORY.md) —— 只跟这份代码有关的记忆。
机器级陷阱和跨项目工作偏好在全局，分层规则见 [`../CLAUDE.md`](../CLAUDE.md) D3。
