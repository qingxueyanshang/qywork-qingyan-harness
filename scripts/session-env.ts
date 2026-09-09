#!/usr/bin/env bun
/**
 * Claude Code 的 SessionStart 钩子：把 `CLAUDE_SCRATCHPAD` 指向的目录建出来。
 *
 * 变量本身由 `.claude/settings.json` 的 `env` 块定义为相对仓库根的 `.tmp/scratch`，
 * Bash 与 PowerShell 两个工具都读得到；`env` 块只接受字面量，不展开 `${CLAUDE_PROJECT_DIR}`，
 * 绝对路径又是本机专属，所以是相对路径。这里按仓库根解析，不按钩子进程的工作目录。
 *
 * Claude Code 本身不设这个变量。Git Bash 里未定义的变量展开为空，`"$CLAUDE_SCRATCHPAD/x.ts"`
 * 变成 `/x.ts`，落进 Git 的安装根目录，命令本身不报错。
 * 不经 `.claude/settings.json` 启动（没有 `CLAUDE_SCRATCHPAD`）时报错退出，不静默返回。
 */
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const value = process.env.CLAUDE_SCRATCHPAD
if (!value) {
  process.stderr.write('缺少 CLAUDE_SCRATCHPAD：它由 .claude/settings.json 的 env 块定义\n')
  process.exit(1)
}
await mkdir(resolve(import.meta.dir, '..', value), { recursive: true })
