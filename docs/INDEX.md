# 文档索引

三份主文档在仓库根，各管一段（分工规则见 [`../CLAUDE.md`](../CLAUDE.md) D1）：

| 文件 | 写什么 |
|---|---|
| [`../README.md`](../README.md) | 对外用法：怎么装、怎么跑、配置长什么样 |
| [`../ARCHITECTURE.md`](../ARCHITECTURE.md) | 为什么这么做，每条附实测数据或踩坑记录 |
| [`../CLAUDE.md`](../CLAUDE.md) | 开发规则 |

## 子系统说明

| 文件 | 写什么 |
|---|---|
| [`permissions.md`](permissions.md) | 权限两模式、裁决三层、内核沙箱与已知边界 |
| [`plugins.md`](plugins.md) | 写一个插件：清单、RPC 协议、宿主能力与权限边界 |
| [`mcp.md`](mcp.md) | 接外部 MCP server：配置、权限、限制 |
| [`team.md`](team.md) | 多角色编排：后端、角色、计划、规则 |
| [`releasing.md`](releasing.md) | Windows 安装包构建、草稿 Release 与公开发布流程 |

## 计划文档

方案、复审与执行记录（`ROADMAP.md` 与 `docs/plans/`）**留在本地，不入库**，
格式与回写纪律见 [`../CLAUDE.md`](../CLAUDE.md) A3/A4。落地后的结论进
[`../ARCHITECTURE.md`](../ARCHITECTURE.md) 与代码注释，那两处才是对外的。

## 项目记忆

[`../.claude/memory/MEMORY.md`](../.claude/memory/MEMORY.md) —— 只跟这份代码有关的记忆。
机器级陷阱和跨项目工作偏好在全局，分层规则见 [`../CLAUDE.md`](../CLAUDE.md) D3。
