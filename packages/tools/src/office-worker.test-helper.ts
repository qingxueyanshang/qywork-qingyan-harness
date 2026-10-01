/**
 * `office.test.ts` 用的假 worker：按协议读请求、写 `response.json`，行为由脚本文件名决定。
 *
 * - `crash.py`：不写结果，以 1 退出（工具随后应以 cleanup 再起一次）。
 * - 其余脚本：给每个输出写一份内容，回报已写入、页数与一条提示。
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
    const img = join(callDir, 'page-1.png')
    writeFileSync(img, PNG)
    respond({
      action: 'view',
      message: '',
      images: [{ path: img, label: `第 ${(req.pages as string[])[0]} 页`, width: 1, height: 1 }],
    })
    break
  }
  case 'cleanup':
    respond({ action: 'cleanup', message: '已结束 1 个本次调用的办公软件进程' })
    break
}
