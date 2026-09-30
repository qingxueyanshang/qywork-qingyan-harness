/** 覆盖 skills/install.ts、import_skill 与 read_skill 的完整导入及失败恢复。 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { openBatchBudget, type ToolContext, ToolRegistry } from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import { strToU8, zipSync } from 'fflate'
import { importSkillTool, readSkillTool, scanSkills } from '../skills.ts'
import { commitSkillDirectory, importSkills } from './install.ts'

let root: string
let home: string
let prior: string | undefined
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'skill-import-'))
  home = await mkdtemp(join(tmpdir(), 'skill-home-'))
  prior = process.env.QYWORK_HOME
  process.env.QYWORK_HOME = home
})
afterEach(() => {
  if (prior === undefined) delete process.env.QYWORK_HOME
  else process.env.QYWORK_HOME = prior
})
const markdown = (name = 'demo', description = '制作视频') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n按步骤生成脚本。\n`
const binary = new Uint8Array([0, 255, 17, 128, 0])
async function bundle(entries: Record<string, Uint8Array>): Promise<string> {
  const path = join(home, `${crypto.randomUUID()}.zip`)
  await writeFile(path, zipSync(entries))
  return path
}
function context(paths: string[] = []): ToolContext {
  return {
    workspaceRoot: root,
    conversationId: 'cv',
    runId: 'rn',
    model: 'fixture',
    contextWindow: 100000,
    density: DEFAULT_DENSITY,
    vision: null,
    resources: new Map(),
    state: openBatchBudget(new Map(), Infinity),
    sink: null,
    signal: new AbortController().signal,
    emit: () => {},
    requestPermission: async () => ({ allowed: true }),
    skillSourcePaths: () => paths,
  }
}

test('会话 ZIP 附件经正式工具导入，包内脚本不执行，二进制保真并可当轮读取', async () => {
  const path = await bundle({
    'release/skills/demo/SKILL.md': strToU8(markdown()),
    'release/skills/demo/assets/中文.bin': binary,
    'release/install.ps1': strToU8('throw "不应执行"'),
  })
  const registry = new ToolRegistry()
  registry.register(importSkillTool)
  registry.register(readSkillTool)
  const ctx = context([path])
  const result = await registry.execute('import_skill', { path }, ctx)
  expect(result.status).toBe('success')
  expect((await scanSkills(root)).map((s) => s.dir)).toEqual([
    join(root, '.agents', 'skills', 'demo'),
  ])
  expect(
    new Uint8Array(await readFile(join(root, '.agents', 'skills', 'demo', 'assets', '中文.bin'))),
  ).toEqual(binary)
  expect((await registry.execute('read_skill', { name: 'demo' }, ctx)).message).toContain(
    '按步骤生成脚本',
  )
  expect(
    (await registry.execute('import_skill', { path: join(home, 'unbound.zip') }, ctx)).status,
  ).toBe('failure')
  expect(await readdir(join(root, '.agents'))).toEqual(['skills'])
})

test('全局导入遵循 QYWORK_HOME；被项目层覆盖时明确回报实际副本', async () => {
  const path = await bundle({ 'demo/SKILL.md': strToU8(markdown()) })
  expect((await importSkills(root, 'project', path)).ok).toBe(true)
  const global = await importSkills(root, 'global', path)
  expect(global.ok).toBe(true)
  expect(global.installed[0]).toMatchObject({
    dir: join(home, 'skills', 'demo'),
    active: false,
    effective: { scope: 'project' },
  })
  expect(await Bun.file(join(root, '.qy', 'skills', 'demo', 'SKILL.md')).exists()).toBe(false)
})

test('无描述、YAML 多行标量、路径穿越及符号链接条目均在提交前拒绝', async () => {
  for (const description of ['', '|']) {
    const path = await bundle({ 'demo/SKILL.md': strToU8(markdown('demo', description)) })
    expect((await importSkills(root, 'project', path)).ok).toBe(false)
  }
  const traversal = await bundle({ '../outside.txt': binary, 'demo/SKILL.md': strToU8(markdown()) })
  expect((await importSkills(root, 'project', traversal)).ok).toBe(false)
  const symlink = join(root, 'link.zip')
  await writeFile(
    symlink,
    zipSync({
      'demo/SKILL.md': strToU8(markdown()),
      'demo/link': [strToU8('/elsewhere'), { attrs: 0xa1ff << 16 }],
    }),
  )
  expect((await importSkills(root, 'project', symlink)).ok).toBe(false)
  expect(await scanSkills(root)).toEqual([])
})

test('替换需要显式授权，升级完整替换资源，失败保持旧版本', async () => {
  const initial = await bundle({
    'demo/SKILL.md': strToU8(markdown()),
    'demo/obsolete.txt': binary,
  })
  await importSkills(root, 'project', initial)
  const next = await bundle({ 'demo/SKILL.md': strToU8(markdown('demo', '新版')) })
  expect((await importSkills(root, 'project', next)).failures[0]?.kind).toBe('conflict')
  expect((await importSkills(root, 'project', next, true)).ok).toBe(true)
  expect(await Bun.file(join(root, '.agents', 'skills', 'demo', 'obsolete.txt')).exists()).toBe(
    false,
  )
  const invalid = await bundle({ 'demo/SKILL.md': strToU8(markdown('demo', '')) })
  expect((await importSkills(root, 'project', invalid, true)).ok).toBe(false)
  expect((await scanSkills(root))[0]?.description).toBe('新版')
})

test('两个并发安装不会覆盖同目录；层内元信息重名也不能静默失效', async () => {
  const path = await bundle({ 'demo/SKILL.md': strToU8(markdown()) })
  const results = await Promise.all([
    importSkills(root, 'project', path),
    importSkills(root, 'project', path),
  ])
  expect(results.filter((r) => r.ok)).toHaveLength(1)
  const dir = join(root, 'other')
  await mkdir(dir)
  await writeFile(join(dir, 'SKILL.md'), markdown())
  expect((await importSkills(root, 'project', dir)).failures[0]?.kind).toBe('conflict')
  expect(await readdir(join(root, '.agents', 'skills'))).toEqual(['demo'])
})

test('多技能分别报告结果；ZIP 根部技能使用实际名称', async () => {
  const multi = await bundle({
    'a/SKILL.md': strToU8(markdown('a')),
    'bad/SKILL.md': strToU8('无元信息'),
  })
  const result = await importSkills(root, 'project', multi)
  expect(result.ok).toBe(false)
  expect(result.installed.map((s) => s.name)).toEqual(['a'])
  expect(result.failures).toHaveLength(1)
  const flat = await bundle({ 'SKILL.md': strToU8(markdown('flat')) })
  expect((await importSkills(root, 'project', flat)).installed[0]?.dir).toBe(
    join(root, '.agents', 'skills', 'flat'),
  )
})

test('Windows CRLF 元信息含后续 metadata 时名称与描述都能识别', async () => {
  const text =
    '---\r\nname: flow-video-script\r\ndescription: AI视频制作\r\nmetadata:\r\n  version: "4.15.0"\r\n---\r\n正文\r\n'
  const path = await bundle({ 'flow-video-script/SKILL.md': strToU8(text) })
  const result = await importSkills(root, 'project', path)
  expect(result.ok).toBe(true)
  expect((await scanSkills(root))[0]).toMatchObject({
    name: 'flow-video-script',
    description: 'AI视频制作',
  })
  expect(await readFile(join(result.installed[0]!.dir, 'SKILL.md'), 'utf8')).toBe(text)
})

test.skipIf(process.platform !== 'win32')(
  '临时目录被占用时保留已生效技能，回执同时报告清理失败',
  async () => {
    let processHolder: ReturnType<typeof spawn> | undefined
    try {
      const receipt = await commitSkillDirectory(root, 'project', 'demo', false, async (stage) => {
        await mkdir(stage)
        await writeFile(join(stage, 'SKILL.md'), markdown())
        processHolder = spawn(
          process.execPath,
          ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'],
          { cwd: dirname(stage), stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
        )
        await new Promise<void>((done, fail) => {
          processHolder!.once('error', fail)
          processHolder!.stdout!.once('data', () => done())
        })
      })
      expect(receipt.active).toBe(true)
      expect(receipt.cleanupError).toContain('清理失败')
      expect((await scanSkills(root)).map((skill) => skill.name)).toEqual(['demo'])
      expect(await readFile(join(receipt.dir, 'SKILL.md'), 'utf8')).toBe(markdown())
    } finally {
      if (processHolder) {
        const closed = new Promise<void>((done) => processHolder!.once('close', () => done()))
        processHolder.kill()
        await closed
      }
    }
  },
)
