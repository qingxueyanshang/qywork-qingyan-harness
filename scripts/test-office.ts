/**
 * Python 单元测试：用 `python -m unittest discover` 依次运行 `packages/runtime/office/tests`（Office worker 的纯逻辑）
 * 与 `scripts/ooxml-fidelity/tests`（保真对比工具的打分与 EMF 回放），任一组失败即失败。
 *
 * 解释器取 `QYWORK_TEST_PYTHON`（CI 的虚拟环境），否则与 `office` 工具同一条查找规则（`findPython`）。
 * 未找到解释器时失败，不跳过：门禁中「未运行」不能显示为「通过」。临时文件位于 `.tmp/test-office`。
 * COM 相关部分无法在 CI 中运行，由真实环境验收覆盖。对比工具依赖的 numpy 随 worker 依赖中的 matplotlib 安装。
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
  process.stderr.write('未找到 Python：Office worker 单元测试无法运行。\n')
  process.exit(1)
}

const SUITES = [OFFICE, join(ROOT, 'scripts', 'ooxml-fidelity')]

for (const dir of SUITES) {
  const proc = Bun.spawn([python, '-m', 'unittest', 'discover', '-s', join(dir, 'tests'), '-v'], {
    cwd: dir,
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
  // unittest 未发现任何测试时退出码为 5，同样判定为失败。
  const code = await proc.exited
  if (code !== 0) process.exit(code)
}
