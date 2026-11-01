/**
 * `pet`：读取、创建与切换 qywork 的宠物。
 *
 * 读写经 `ctx.pets` 端口完成，宠物库位于 `~/.qywork/pets/`。`apply` 只核对宠物存在并返回 id，
 * 切换由界面在当前会话收到成功结果后执行，理由同 `skin` 工具。
 */

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolSpec } from '@qywork/agent'
import { type PetEntry, parsePetPack, petFrameFiles } from '@qywork/core'
import { resolveInWorkspace, rootsOf } from '../paths.ts'

/** `apply` 切回内置宠物时使用的 id。 */
const DEFAULT = 'default'

type Outcome = Awaited<ReturnType<ToolSpec['fn']>>

function failure(message: string): Outcome {
  return { status: 'failure', executed: false, message, errorKind: 'invalid_tool_arguments' }
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

const summaryOf = (e: PetEntry) => `「${e.pack.name}」（${e.id}）`

export const petTool: ToolSpec = {
  name: 'pet',
  description:
    '读取、创建与切换 qywork 的宠物。宠物显示在侧栏底部，用五个状态表现任务进度：' +
    'desktop（AI 正在操作电脑）、failed（任务出错）、working（任务运行中）、done（任务完成）、idle（空闲）。' +
    '每个状态是一组循环播放的帧图片，只有一帧时界面自动加上呼吸、跳动等基础动作。' +
    'action=list 列出宠物；read 读取一只宠物的完整参数；' +
    'save 新建（省略 id）或替换（给出 id）宠物：dir 是工作区中存放帧图片的目录，pack_json 中的文件名指该目录下的文件；' +
    '帧图片优先使用透明背景的正方形 PNG，各状态的角色外形保持一致；save 只保存，不切换。' +
    'apply 把用户当前界面的宠物切换为 id 指定的宠物，id 为 default 时切回内置宠物。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'read', 'save', 'apply'] },
      id: {
        type: 'string',
        description:
          '宠物 id。read、apply 必填；save 时省略表示新建；apply 时 default 表示内置宠物',
      },
      pack_json: {
        type: 'string',
        description:
          '宠物包，JSON 对象，save 时使用：{"name":名称,"size":显示尺寸 48–160,' +
          '"states":{"desktop"|"failed"|"working"|"done"|"idle":{"frames":[文件名，1–24 个，可重复],"fps":每秒帧数 1–24}}}，五个状态都必填。' +
          '文件名为 png、webp、gif、svg、jpg，不含路径',
      },
      dir: { type: 'string', description: '工作区中存放帧图片的目录，save 时使用' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  actionKind: (args) =>
    args.action === 'save' ? 'edit' : args.action === 'apply' ? 'call' : 'read',
  objectLabel: '宠物',
  category: 'session',
  facet: '外观',
  summary: '读取、创建与切换宠物',
  targetExtractor: (a) => text(a.id),
  permissionEffect: (args) => (args.action === 'save' ? 'write' : 'read'),
  parallelSafe: false,

  async fn(args, ctx) {
    const port = ctx.pets
    if (!port) return failure('本次执行没有宠物库通道')
    const action = args.action
    const id = text(args.id)

    if (action === 'list') {
      const pets = await port.list()
      const lines = [`- ${DEFAULT}：团子（内置）`, ...pets.map((e) => `- ${e.id}：${e.pack.name}`)]
      return {
        status: 'success',
        message: `共 ${pets.length + 1} 只宠物：\n${lines.join('\n')}`,
        data: { pets: pets.map((e) => ({ id: e.id, name: e.pack.name })) },
      }
    }

    if (action === 'read') {
      if (!id) return failure('read 需要 id')
      const entry = await port.read(id)
      if (!entry) return failure(`宠物不存在：${id}`)
      return {
        status: 'success',
        message: `宠物${summaryOf(entry)}：\n${JSON.stringify(entry.pack, null, 2)}`,
        data: { id: entry.id, pack: entry.pack },
      }
    }

    if (action === 'apply') {
      if (!id) return failure('apply 需要 id；切回内置宠物时传 default')
      if (id === DEFAULT) {
        return { status: 'success', message: '已请求界面切回内置宠物', data: { applied: null } }
      }
      const entry = await port.read(id)
      if (!entry) return failure(`宠物不存在：${id}`)
      return {
        status: 'success',
        message: `已请求界面切换到宠物${summaryOf(entry)}`,
        data: { applied: entry.id },
      }
    }

    if (action === 'save') {
      const src = text(args.pack_json)
      const dirArg = text(args.dir)
      if (!src || !dirArg) return failure('save 需要 pack_json 与 dir')
      let raw: unknown
      try {
        raw = JSON.parse(src)
      } catch (e) {
        return failure(`pack_json 无法解析：${e instanceof Error ? e.message : String(e)}`)
      }
      const parsed = parsePetPack(raw)
      if (!parsed.ok) return failure(parsed.error)
      if (id && !(await port.read(id))) return failure(`宠物不存在：${id}`)
      const dir = await resolveInWorkspace(rootsOf(ctx), dirArg, { mustExist: true })
      // 只读取目录中存在的文件：替换已有宠物时，未改动的帧可以留在宠物库中，由端口核对。
      const images: { name: string; bytes: Uint8Array }[] = []
      for (const name of petFrameFiles(parsed.value)) {
        const file = join(dir, name)
        if ((await stat(file).catch(() => null))?.isFile()) {
          images.push({ name, bytes: new Uint8Array(await readFile(file)) })
        }
      }
      const saved = await port.save(id, parsed.value, images)
      if (!saved.ok) return failure(saved.error)
      return {
        status: 'success',
        message: `已${id ? '替换' : '新建'}宠物${summaryOf(saved.entry)}${id ? '' : '；切换到它需再调用 apply'}`,
        data: { id: saved.entry.id },
      }
    }

    return failure('action 必须是 list、read、save 或 apply')
  },
}
