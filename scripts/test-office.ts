/**
 * Office worker 的纯逻辑单测：`python -m unittest discover` 跑 `packages/runtime/office/tests`。
 *
 * 解释器取 `QYWORK_TEST_PYTHON`（CI 的虚拟环境），否则与 `office` 工具同一条查找规则（`findPython`）。
 * 找不到解释器时失败，不跳过：门禁里「没跑」不能显示成「通过」。临时文件落在 `.tmp/test-office`。
 * COM 相关的部分进不了 CI，由真机验收覆盖。
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { findPython, type QyConfig } from '../packages/runtime/src/index.ts'

const ROOT = join(import.meta.dir, '..')
const OFFICE = join(ROOT, 'packages', 'runtime', 'office')
const TEMP = join(ROOT, '.tmp', 'test-office')
mkdirSync(TEMP, { recursive: true })

const python = process.env.QYWORK_TEST_PYTHON || findPython({ providers: {} } as QyConfig)
if (!python) {
  process.stderr.write('没有找到 Python：Office worker 单测无法运行。\n')
  process.exit(1)
}

const proc = Bun.spawn([python, '-m', 'unittest', 'discover', '-s', join(OFFICE, 'tests'), '-v'], {
  cwd: OFFICE,
  stdout: 'inherit',
  stderr: 'inherit',
  env: {
    ...process.env,
    TEMP,
    TMP: TEMP,
    TMPDIR: TEMP,
    PYTHONIOENCODING: 'utf-8',
    PYTHONDONTWRITEBYTECODE: '1',
  },
})
// unittest 一个测试都没发现时退出码是 5，同样判失败。
process.exit(await proc.exited)
