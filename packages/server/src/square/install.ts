/**
 * 安装创作广场中的条目：按类型交给电脑端现有的安装入口，本文件不另写落盘逻辑。
 *
 * - 插件：`readPluginDir` 校验后 `copyPluginDir` 复制到全局插件目录；已安装同一 id 时拒绝，与插件页的导入相同。
 * - 技能：`importSkills` 安装到全局层。
 * - MCP：`mergeMcpServers` 写入全局层的 `mcp.json`；同名 server 已存在时拒绝。
 * - 宠物：`savePet` 新建一只宠物。皮肤：`savePersonalization` 替换当前的个性化。
 * - 画布：文件放入当前项目的新目录，画布文档经 `CanvasDocs.importDoc` 写入。
 *
 * 作品与提示词没有安装：作品在线查看，提示词由界面放入输入框。
 */

import { readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  type CanvasDoc,
  parseCanvas,
  type SquareDetail,
  type SquareKind,
  type SquareMetaByKind,
} from '@qywork/core'
import { mergeMcpServers, savePersonalization, savePet } from '@qywork/runtime'
import { importSkills } from '@qywork/tools'
import { copyPluginDir, readPluginDir } from '../api/plugins.ts'
import type { CanvasService } from '../canvas/service.ts'
import type { CloudAccount } from '../cloud/account.ts'
import { stageSnapshot } from './files.ts'

export type InstallableKind = Exclude<SquareKind, 'work' | 'prompt'>

export type InstallResult =
  | { ok: true; message: string /** 导入的画布文件，工作区相对路径。 */; canvas?: string }
  | { ok: false; status: 409 | 422; error: string }

export interface InstallContext {
  account: CloudAccount
  canvas: CanvasService
  workspaceRoot: string
}

type Installer = (detail: SquareDetail, ctx: InstallContext) => Promise<InstallResult>

/** 把快照放入临时目录交给 `use`，结束后删除临时目录。 */
async function withSnapshot<T>(
  detail: SquareDetail,
  ctx: InstallContext,
  name: string,
  use: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await stageSnapshot(ctx.account, detail.files, name)
  try {
    return await use(dir)
  } finally {
    await rm(dirname(dir), { recursive: true, force: true })
  }
}

/** 快照中的图片文件，按文件名（宠物帧与皮肤背景都位于快照根目录）。 */
async function images(dir: string, names: readonly string[]) {
  return Promise.all(names.map(async (name) => ({ name, bytes: await readFile(join(dir, name)) })))
}

/** 文件卡、生成卡各版本（含生成时的输入）与时间线片段的路径加上前缀 `folder/`。 */
function relocate(doc: CanvasDoc, folder: string): CanvasDoc {
  const at = (p: string) => `${folder}/${p}`
  return {
    ...doc,
    nodes: doc.nodes.map((n) =>
      n.type === 'file'
        ? { ...n, path: at(n.path) }
        : n.type === 'generate'
          ? {
              ...n,
              versions: n.versions.map((v) => ({
                ...v,
                path: at(v.path),
                made: { ...v.made, inputs: v.made.inputs.map((i) => ({ ...i, path: at(i.path) })) },
              })),
            }
          : { ...n, clips: n.clips.map((c) => ({ ...c, path: at(c.path) })) },
    ),
  }
}

const INSTALLERS: Record<InstallableKind, Installer> = {
  plugin: (detail, ctx) =>
    withSnapshot(detail, ctx, 'plugin', async (dir) => {
      const found = await readPluginDir(dir)
      if (!found.ok || !found.id)
        return { ok: false, status: 422, error: found.error ?? '清单不合法' }
      if (found.replacing) {
        return { ok: false, status: 409, error: `已安装同名插件 ${found.id}，请先卸载` }
      }
      const done = await copyPluginDir(dir, found.id, { replace: false })
      return done.ok
        ? { ok: true, message: `已安装插件 ${found.name}，重启后加载` }
        : { ok: false, status: 422, error: done.error ?? '安装失败' }
    }),

  skill: (detail, ctx) => {
    const meta = detail.meta as SquareMetaByKind['skill']
    return withSnapshot(detail, ctx, meta.name, async (dir) => {
      const result = await importSkills(ctx.workspaceRoot, 'global', dir)
      if (result.ok) return { ok: true, message: `已安装全局技能 ${meta.name}` }
      const conflict = result.failures.some((f) => f.kind === 'conflict')
      return {
        ok: false,
        status: conflict ? 409 : 422,
        error: result.failures.map((f) => f.error).join('；'),
      }
    })
  },

  async mcp(detail, ctx) {
    const { name, server } = detail.meta as SquareMetaByKind['mcp']
    const result = await mergeMcpServers(ctx.workspaceRoot, 'global', { [name]: server })
    if (result.ok) return { ok: true, message: `已添加全局 MCP ${name}` }
    return { ok: false, status: result.kind === 'conflict' ? 409 : 422, error: result.error }
  },

  pet: (detail, ctx) =>
    withSnapshot(detail, ctx, 'pet', async (dir) => {
      const pack = JSON.parse(await readFile(join(dir, 'pet.json'), 'utf8')) as unknown
      const frames = detail.files.map((f) => f.path).filter((p) => p !== 'pet.json')
      const saved = await savePet(null, pack, await images(dir, frames))
      return saved.ok
        ? { ok: true, message: `已添加宠物 ${saved.entry.pack.name}` }
        : { ok: false, status: 422, error: saved.error }
    }),

  skin: (detail, ctx) =>
    withSnapshot(detail, ctx, 'skin', async (dir) => {
      const raw = JSON.parse(await readFile(join(dir, 'skin.json'), 'utf8')) as unknown
      const pictures = detail.files.map((f) => f.path).filter((p) => p !== 'skin.json')
      const saved = await savePersonalization(raw, await images(dir, pictures))
      return saved.ok
        ? { ok: true, message: '已应用皮肤' }
        : { ok: false, status: 422, error: saved.error }
    }),

  canvas: (detail, ctx) =>
    withSnapshot(detail, ctx, 'canvas', async (dir) => {
      const parsed = parseCanvas(await readFile(join(dir, 'canvas.json'), 'utf8'))
      if (!parsed.ok) return { ok: false, status: 422, error: parsed.error }
      const files = detail.files
        .filter((f) => f.path.startsWith('files/'))
        .map((f) => ({
          path: f.path.slice('files/'.length),
          source: join(dir, ...f.path.split('/')),
        }))
      const path = await ctx.canvas.docs.importDoc(
        ctx.workspaceRoot,
        detail.title,
        files,
        (folder) => relocate(parsed.doc, folder),
      )
      return { ok: true, message: `已导入画布 ${path}`, canvas: path }
    }),
}

export function isInstallable(kind: SquareKind): kind is InstallableKind {
  return kind in INSTALLERS
}

/** 安装一个条目的最新已上架版本。`detail` 取自云端的条目详情。 */
export function installSquareItem(
  detail: SquareDetail,
  ctx: InstallContext,
): Promise<InstallResult> {
  if (!isInstallable(detail.kind)) {
    return Promise.resolve({ ok: false, status: 422, error: `${detail.kind} 类型的条目不能安装` })
  }
  return INSTALLERS[detail.kind](detail, ctx)
}
