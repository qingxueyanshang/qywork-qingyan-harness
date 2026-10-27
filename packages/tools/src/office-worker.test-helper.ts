/**
 * `office.test.ts`、`tools.test.ts`（视频抽帧）与 `canvas.test.ts`（取帧）使用的模拟 worker：按协议读取请求并写入 `response.json`，
 * 行为由脚本文件名决定。
 *
 * - `crash.py`：不写结果，以退出码 1 退出（工具随后应以 cleanup 动作再启动一次 worker）。
 * - `uncommitted.py`：只在调用目录的 `work/` 中写出候选文件，返回未提交。
 * - 其余脚本：为每个输出写入内容，返回已写入状态、页数与一条检查提示。
 * 每次调用把收到的请求追加到调用目录上一级的 `requests.jsonl`，测试据此核对请求。
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

const req = JSON.parse(readFileSync(process.argv[2] ?? '', 'utf8')) as Record<string, unknown>
const callDir = String(req.call_dir)
appendFileSync(join(dirname(callDir), 'requests.jsonl'), `${JSON.stringify(req)}\n`)
const sha = (bytes: Uint8Array) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
const respond = (body: Record<string, unknown>) =>
  writeFileSync(join(callDir, 'response.json'), JSON.stringify({ ok: true, ...body }))

switch (req.action) {
  case 'guide':
    respond({ action: 'guide', message: '', text: `做法：${String(req.format)}` })
    break
  case 'read': {
    const path = String(req.path)
    respond({
      action: 'read',
      message: '',
      text: '段落 1：标题',
      files: [
        { path, committed: false, sha256: sha(readFileSync(path)), candidate: null, pages: null },
      ],
    })
    break
  }
  case 'write': {
    if (basename(String(req.script)) === 'crash.py') process.exit(1)
    const outputs = req.outputs as { path: string; expected_sha256: string | null }[]
    if (basename(String(req.script)) === 'uncommitted.py') {
      mkdirSync(join(callDir, 'work'), { recursive: true })
      const pending = outputs.map((o, i) => {
        const candidate = join(callDir, 'work', `${i}-${basename(o.path)}`)
        writeFileSync(candidate, '候选')
        return { path: o.path, committed: false, sha256: null, candidate, pages: null, checks: [] }
      })
      respond({ ok: false, action: 'write', message: '已提交 0 / 1 个文件', files: pending })
      break
    }
    const files = outputs.map((o) => {
      const bytes = Buffer.from(`内容 ${basename(o.path)}`)
      mkdirSync(dirname(o.path), { recursive: true })
      writeFileSync(o.path, bytes)
      return {
        path: o.path,
        committed: true,
        sha256: sha(bytes),
        candidate: null,
        pages: 3,
        checks: [
          { level: 'warning', code: 'overlap', message: `预期 ${o.expected_sha256 ?? '无'}` },
        ],
      }
    })
    for (const p of req.pdf as { path: string }[]) writeFileSync(p.path, 'pdf')
    respond({ action: 'write', message: '已执行脚本', files, script_output: 'hello' })
    break
  }
  case 'view': {
    // 每个请求的页码返回一张图，与实际 worker 相同带回页码。
    const images = (req.pages as string[]).map((key, i) => {
      const img = join(callDir, `page-${i}.png`)
      writeFileSync(img, PNG)
      return { path: img, key, label: `第 ${key} 页`, width: 1, height: 1 }
    })
    respond({ action: 'view', message: '', images })
    break
  }
  case 'frames': {
    // 返回两帧，说明中回显收到的区间，测试据此核对 start / end 已传给 worker。
    // 与实际 worker 相同，帧写入调用目录下的 frames/，工具读取后应删除该目录。
    mkdirSync(join(callDir, 'frames'), { recursive: true })
    const images = [0, 1].map((i) => {
      const img = join(callDir, 'frames', `frame-${i}.jpg`)
      writeFileSync(img, PNG)
      return { path: img, label: `00:0${i}.0`, width: 1, height: 1 }
    })
    respond({
      action: 'frames',
      message: '返回 2 帧',
      text: `区间 ${String(req.start ?? '头')}–${String(req.end ?? '尾')}；声音未处理`,
      images,
    })
    break
  }
  case 'frame': {
    // 视频时长按 6 秒，越界的时刻取尾帧；与实际 worker 相同，帧写入调用目录下的 frame.png。
    // 路径名为 broken.mp4 时返回无法解码，测试据此核对失败回执。
    if (basename(String(req.path)) === 'broken.mp4') {
      respond({ ok: false, action: 'frame', message: 'broken.mp4 无法打开' })
      break
    }
    const img = join(callDir, 'frame.png')
    writeFileSync(img, PNG)
    respond({
      action: 'frame',
      message: '',
      images: [{ path: img, label: '00:02.5', width: 1, height: 1 }],
      frame: { time: Math.min(Number(req.at), 5.96), duration: 6 },
    })
    break
  }
  case 'cleanup':
    respond({ action: 'cleanup', message: '已结束 1 个本次调用的办公软件进程' })
    break
}
