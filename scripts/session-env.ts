#!/usr/bin/env bun
/**
 * Claude Code 的 SessionStart 钩子：创建 `CLAUDE_SCRATCHPAD` 指向的目录。
 *
 * 变量本身由 `.claude/settings.json` 的 `env` 块定义为相对仓库根的 `.tmp/scratch`，
 * Bash 与 PowerShell 两个工具都能读取；`env` 块只接受字面量，不展开 `${CLAUDE_PROJECT_DIR}`，
 * 绝对路径只适用于本机，因此使用相对路径。本脚本按仓库根解析，不按钩子进程的工作目录解析。
 *
 * Claude Code 本身不设置该变量。Git Bash 中未定义的变量展开为空，`"$CLAUDE_SCRATCHPAD/x.ts"`
 * 变为 `/x.ts`，写入 Git 的安装根目录，且命令不报错。
 * 不经 `.claude/settings.json` 启动（没有 `CLAUDE_SCRATCHPAD`）时报错退出，不静默返回。
 */
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const value = process.env.CLAUDE_SCRATCHPAD
if (!value) {
  process.stderr.write('缺少 CLAUDE_SCRATCHPAD：该变量由 .claude/settings.json 的 env 块定义\n')
  process.exit(1)
}
await mkdir(resolve(import.meta.dir, '..', value), { recursive: true })
