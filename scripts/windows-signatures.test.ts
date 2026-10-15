/** 覆盖 Windows 发布包签名检查的真实系统验签、缺失程序及工作流连接。 */
import { describe, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const check = join(import.meta.dir, 'check-windows-signatures.ps1')

describe.skipIf(process.platform !== 'win32')('Windows 发布包签名', () => {
  test('可信文件通过严格检查；遗漏、未签名或篡改组件不能通过', () => {
    const dir = mkdtempSync(join(tmpdir(), 'windows-signatures-'))
    const payload = join(dir, "中文 空格'目录")
    mkdirSync(payload)
    const signed = join(
      process.env.SystemRoot!,
      'System32',
      'WindowsPowerShell/v1.0/powershell.exe',
    )
    const installer = join(dir, 'setup.exe')
    const report = join(dir, 'signatures.json')
    copyFileSync(signed, installer)
    for (const name of ['qywork.exe', 'qy.exe', 'qy-computer-host.exe']) {
      copyFileSync(signed, join(payload, name))
    }
    function run(required: boolean) {
      const env = { ...process.env }
      delete env.PSModulePath
      const result = Bun.spawnSync(
        [
          'powershell.exe',
          '-NoProfile',
          '-NonInteractive',
          '-File',
          check,
          '-InstallerPath',
          installer,
          '-PayloadDirectory',
          payload,
          '-ReportPath',
          report,
          ...(required ? ['-RequireSigned'] : []),
        ],
        { cwd: root, env, timeout: 20_000 },
      )
      expect(result.stderr.toString()).not.toContain('ParserError')
      return {
        code: result.exitCode,
        report: JSON.parse(readFileSync(report, 'utf8')),
        output: result.stdout.toString() + result.stderr.toString(),
      }
    }
    try {
      const valid = run(true)
      expect(valid.code, JSON.stringify(valid)).toBe(0)
      expect(valid.report.allValid).toBe(true)
      expect(valid.report.files).toHaveLength(4)

      const bytes = readFileSync(join(payload, 'qy.exe'))
      // PE 节内修改必须破坏 Authenticode，不能只改不参与签名的校验和字段。
      bytes[1024] = bytes[1024]! ^ 1
      writeFileSync(join(payload, 'qy.exe'), bytes)
      const damaged = run(true)
      expect(damaged.code).toBe(1)
      expect(damaged.report.allValid).toBe(false)
      expect(
        damaged.report.files.find((f: { file: string }) => f.file === 'qy.exe').status,
      ).not.toBe('Valid')

      writeFileSync(join(payload, 'extra.dll'), 'unsigned executable fixture')
      const audit = run(false)
      expect(audit.code).toBe(0)
      expect(audit.report.mode).toBe('audit')
      expect(audit.report.allValid).toBe(false)
      expect(audit.report.files).toHaveLength(5)

      rmSync(join(payload, 'qy-computer-host.exe'))
      const missing = run(false)
      expect(missing.code).toBe(1)
      expect(missing.report.missing).toEqual(['qy-computer-host.exe'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 90_000)
})

test('Windows 工作流验证本次安装包中的文件，并保留失败报告', () => {
  const workflow = Bun.YAML.parse(
    readFileSync(join(root, '.github/workflows/release-windows.yml'), 'utf8'),
  ) as {
    jobs: {
      release: {
        steps: {
          name: string
          id?: string
          if?: string
          run?: string
          env?: Record<string, string>
        }[]
      }
    }
  }
  const steps = workflow.jobs.release.steps
  const checkAt = steps.findIndex((step) => step.id === 'authenticode')
  expect(checkAt).toBeGreaterThan(steps.findIndex((step) => step.id === 'tauri'))
  const step = steps[checkAt]!
  expect(step.run).toContain('& 7z x $installers[0].FullName')
  expect(step.run).toContain('-PayloadDirectory $payload')
  expect(step.env?.REQUIRE_SIGNATURE).toContain('vars.QYWORK_REQUIRE_WINDOWS_SIGNATURE')
  expect(step.run).toContain('exit $LASTEXITCODE')
  const upload = steps[checkAt + 1]!
  expect(upload.if).toContain('always()')
  expect(upload.run).toContain('gh release upload')
  expect(upload.run).toContain('WINDOWS-SIGNATURES.json')
})
