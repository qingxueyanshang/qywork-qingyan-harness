/** 画布上的文件：取帧、上传、导入本机文件，以及设计稿页面的渲染。新节点经 `CanvasDocs.apply` 写入。 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { artPageSize, canvasFileKind, canvasMediaOf, displayNameOf } from '@qywork/core'
import { type CanvasRender, landFiles } from '@qywork/tools'
import { type CanvasDocs, CanvasFailure } from './docs.ts'

/** PNG 文件头。取帧只接受 PNG：浏览器导出的格式即为 PNG，其他格式表明请求并非来自取帧。 */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/**
 * 设计稿页面的渲染：页面原文、页面文件的绝对路径与显示尺寸 → PNG（base64）与页面脚本报错。
 * 由服务端以内置浏览器的隐藏页实现（`BrowserCoordinator.renderArt`），按会话绑定后交给画布端口。
 */
export type ArtRender = (page: {
  html: string
  pagePath: string
  width: number
  height: number
}) => Promise<{ png: string; errors: string[] }>

export class CanvasAssets {
  constructor(private readonly docs: CanvasDocs) {}

  /**
   * 设计稿卡按页面的显示尺寸（`artPageSize`，与画布显示相同）渲染并截图。生成卡取当前版本的页面，
   * `.html` 文件卡取其文件。不是设计稿卡、尚无结果或页面无法读取的项写明原因，其余照常渲染。
   */
  async renderArt(
    workspaceRoot: string,
    path: string,
    keys: string[],
    render: ArtRender,
  ): Promise<CanvasRender[]> {
    const { doc } = await this.docs.read(workspaceRoot, path)
    const out: CanvasRender[] = []
    for (const key of keys) {
      const node =
        doc.nodes.find((n) => n.id === key) ?? doc.nodes.find((n) => displayNameOf(n) === key)
      if (!node) {
        out.push({ name: key, failure: '画布上没有这张卡' })
        continue
      }
      const name = displayNameOf(node)
      const art = node.type === 'generate' && node.output === 'art'
      const page = art
        ? node.versions.find((v) => v.id === node.current)?.path
        : node.type === 'file' && canvasFileKind(node.path) === 'art'
          ? node.path
          : undefined
      if (!page) {
        out.push({ name, failure: art ? '尚无结果' : '不是设计稿卡' })
        continue
      }
      const pagePath = join(workspaceRoot, page)
      const html = await readFile(pagePath, 'utf8').catch(() => null)
      if (html === null) {
        out.push({ name, failure: `页面文件不存在：${page}` })
        continue
      }
      const size = artPageSize(html)
      const shot = await render({ html, pagePath, width: size.w, height: size.h })
      out.push({ name, size, png: shot.png, errors: shot.errors })
    }
    return out
  }

  /**
   * 接收浏览器从视频节点截取的一帧或从 Art 节点截取的画面（PNG），按生成产物的落盘规则写入
   * `generated/<节点名>_<label>.png`（不覆盖，重名时加 `-2`），并在该节点右侧添加一个引用它的节点。
   * 返回新节点的 id 与文件路径。
   */
  async captureFrame(
    workspaceRoot: string,
    path: string,
    sourceId: string,
    label: string,
    bytes: Uint8Array,
  ): Promise<{ nodeId: string; path: string }> {
    if (!PNG_SIGNATURE.every((b, i) => bytes[i] === b)) {
      throw new CanvasFailure('收到的不是 PNG 图片', 422)
    }
    const doc = await this.docs.load(await this.docs.locate(workspaceRoot, path))
    const source = doc.nodes.find((n) => n.id === sourceId)
    if (!source) throw new CanvasFailure(`目标已不存在：${sourceId}`, 404)
    const kind = canvasMediaOf(source)
    if (kind !== 'video' && kind !== 'art') {
      throw new CanvasFailure('只能从视频或 Art 节点截取画面', 422)
    }
    const name = `${displayNameOf(source)}_${label}`.replace(/[\\/:*?"<>|]/g, '_')
    // 必须写出完整扩展名：名称为 `12.4s` 时若不带扩展名，`.4s` 会被视为扩展名，文件保存为无法识别的类型。
    const [landed] = await landFiles(
      workspaceRoot,
      [{ bytes, mime: 'image/png' }],
      `generated/${name}.png`,
    )
    const { refs } = await this.docs.apply(workspaceRoot, path, [
      { op: 'add_file', ref: '$frame', path: landed!.path, beside: source.id },
    ])
    return { nodeId: refs.$frame!, path: landed!.path }
  }

  /**
   * 接收从本机选择的文件，按原名写入工作区 `uploads/`（不覆盖，重名时加 `-2`），并添加一个引用它的节点：
   * 给出 `beside` 时放在该节点右侧的空位，否则以 `near` 为中心查找空位。画布只引用文件，删除节点不删除文件。
   */
  async upload(
    workspaceRoot: string,
    path: string,
    name: string,
    bytes: Uint8Array,
    place: { near: { x: number; y: number } } | { beside: string },
  ): Promise<{ nodeId: string; path: string }> {
    if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) {
      throw new CanvasFailure(`文件名不合法：${name}`, 422)
    }
    await this.docs.locate(workspaceRoot, path)
    const [landed] = await landFiles(
      workspaceRoot,
      // 按原名落盘：未登记的类型不改扩展名。
      [{ bytes, mime: 'application/octet-stream' }],
      `uploads/${name.replace(/[:*?"<>|]/g, '_')}`,
    )
    const { refs } = await this.docs.apply(workspaceRoot, path, [
      {
        op: 'add_file',
        ref: '$file',
        path: landed!.path,
        ...('beside' in place ? { beside: place.beside } : { near: place.near }),
      },
    ])
    return { nodeId: refs.$file!, path: landed!.path }
  }

  /**
   * 从系统拖入的本机文件（绝对路径）：位于工作区中的直接引用，位于工作区外的按原名复制到 `uploads/`。
   * 第一个文件以 `near` 为中心查找空位，之后的依次排在前一个右侧。返回新节点的 id；任一路径不存在或不是文件时停止并报错。
   */
  async importPaths(
    workspaceRoot: string,
    path: string,
    files: string[],
    near: { x: number; y: number },
  ): Promise<string[]> {
    await this.docs.locate(workspaceRoot, path)
    const ids: string[] = []
    for (const file of files) {
      const abs = await realpath(file).catch(() => {
        throw new CanvasFailure(`${file} 不存在`, 404)
      })
      if (!(await stat(abs)).isFile()) throw new CanvasFailure(`${file} 不是文件`, 422)
      const inside = await this.docs.relativeTo(workspaceRoot, abs).catch(() => null)
      const rel =
        inside ??
        (
          await landFiles(
            workspaceRoot,
            [{ bytes: new Uint8Array(await readFile(abs)), mime: 'application/octet-stream' }],
            `uploads/${basename(abs)}`,
          )
        )[0]!.path
      const prev = ids.at(-1)
      const { refs } = await this.docs.apply(workspaceRoot, path, [
        { op: 'add_file', ref: '$f', path: rel, ...(prev ? { beside: prev } : { near }) },
      ])
      ids.push(refs.$f!)
    }
    return ids
  }
}
