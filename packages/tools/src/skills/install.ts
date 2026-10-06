/** 技能目录与 ZIP 共用的校验、完整提交及扫描回执。 */
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { unzipSync } from 'fflate'
import { withFileLocks } from '../file-lock.ts'
import { scopeDir, scopeRoots } from '../scopes.ts'
import { parseFrontmatter, type SkillMeta, scanSkillDir, scanSkills } from '../skills.ts'

type WritableScope = 'project' | 'global'
export class SkillInstallError extends Error {
  constructor(
    message: string,
    readonly kind: 'invalid' | 'conflict' = 'invalid',
  ) {
    super(message)
  }
}

export interface SkillReceipt {
  name: string
  scope: WritableScope
  dir: string
  replaced: boolean
  effective: SkillMeta
  active: boolean
  cleanupError?: string
}

export function skillDirectoryName(name: string): string {
  const value = name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  if (!value || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) {
    throw new SkillInstallError('技能目录名无效')
  }
  return value
}

export function skillLayerRoot(workspace: string, scope: WritableScope): string {
  return scopeDir(scopeRoots(workspace), scope, 'skills')!
}

export async function validateSkillDirectory(
  dir: string,
): Promise<{ name: string; description: string }> {
  const text = await readFile(join(dir, 'SKILL.md'), 'utf8').catch(() => null)
  if (text === null) throw new SkillInstallError(`目录中没有可读取的 SKILL.md：${dir}`)
  const meta = parseFrontmatter(text)
  if (!meta.description || /^[|>][+-]?\d?$/.test(meta.description)) {
    throw new SkillInstallError(`SKILL.md 的 description 必须是非空的单行文本：${dir}`)
  }
  return { name: meta.name || basename(dir), description: meta.description }
}

/** 同层临时目录位于 skills 之外，扫描器不会收录待提交或回滚副本。 */
export async function commitSkillDirectory(
  workspace: string,
  scope: WritableScope,
  directoryName: string,
  replace: boolean,
  prepare: (stage: string, target: string) => Promise<void>,
  removeSource?: string,
): Promise<SkillReceipt> {
  const root = skillLayerRoot(workspace, scope)
  const target = join(root, skillDirectoryName(directoryName))
  return withFileLocks([root, ...(removeSource ? [dirname(removeSource)] : [])], async () => {
    const existed = (await lstat(target).catch(() => null)) !== null
    if (existed && !replace) throw new SkillInstallError(`该层已有技能目录：${target}`, 'conflict')
    await mkdir(dirname(root), { recursive: true })
    const transaction = await mkdtemp(join(dirname(root), '.skill-install-'))
    const stage = join(transaction, basename(target))
    const backup = join(transaction, 'backup')
    let committed = false
    let backedUp = false
    let sourceBackup: string | null = null
    try {
      await prepare(stage, target)
      const meta = await validateSkillDirectory(stage)
      const clash = (await scanSkillDir(root, scope)).find(
        (s) => s.name === meta.name && resolve(s.dir) !== resolve(target),
      )
      if (clash)
        throw new SkillInstallError(`同层已有名为 ${meta.name} 的技能：${clash.dir}`, 'conflict')
      await mkdir(root, { recursive: true })
      if (existed) {
        await rename(target, backup)
        backedUp = true
      }
      await rename(stage, target)
      committed = true
      const installed = (await scanSkillDir(root, scope)).find(
        (s) => s.dir === target && s.name === meta.name,
      )
      if (!installed) throw new SkillInstallError(`提交后扫描未找到技能：${target}`)
      await readFile(join(installed.dir, 'SKILL.md'))
      const effective = (await scanSkills(workspace)).find((s) => s.name === meta.name)
      if (!effective) throw new SkillInstallError(`提交后技能未进入索引：${meta.name}`)
      if (removeSource) {
        sourceBackup = join(dirname(dirname(removeSource)), `.skill-move-${crypto.randomUUID()}`)
        await rename(removeSource, sourceBackup)
      }
      const active = (await scanSkills(workspace)).find((s) => s.name === meta.name)!
      let cleanupError: string | undefined
      try {
        if (sourceBackup) await rm(sourceBackup, { recursive: true, force: true })
        await rm(transaction, { recursive: true, force: true })
      } catch (error) {
        cleanupError = `临时副本清理失败：${transaction}${sourceBackup ? `；${sourceBackup}` : ''}；${String(error)}`
      }
      return {
        name: meta.name,
        scope,
        dir: target,
        replaced: existed,
        effective: active,
        active: active.dir === target,
        ...(cleanupError ? { cleanupError } : {}),
      }
    } catch (error) {
      if (sourceBackup && removeSource) await rename(sourceBackup, removeSource)
      if (committed) await rm(target, { recursive: true, force: true })
      if (backedUp) await rename(backup, target)
      await rm(transaction, { recursive: true, force: true })
      throw error
    }
  })
}

async function inspectTree(dir: string): Promise<void> {
  const info = await lstat(dir)
  if (info.isSymbolicLink()) throw new SkillInstallError(`技能包不接受符号链接：${dir}`)
  if (info.isDirectory()) {
    for (const name of await readdir(dir)) await inspectTree(join(dir, name))
  } else if (!info.isFile()) throw new SkillInstallError(`技能包含非普通文件：${dir}`)
}

async function discover(dir: string): Promise<string[]> {
  if (await stat(join(dir, 'SKILL.md')).catch(() => null)) return [dir]
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) found.push(...(await discover(join(dir, entry.name))))
  }
  return found
}

function zipPath(name: string): string {
  if (
    !name ||
    name.includes('\\') ||
    name.startsWith('/') ||
    name.includes(':') ||
    name.includes('\0') ||
    name.split('/').some((s) => s === '..' || s === '.')
  ) {
    throw new SkillInstallError(`ZIP 条目路径无效：${name}`)
  }
  return name
}

/** ZIP 仅支持普通文件与目录；拒绝链接及重复路径，避免解包后语义变化。 */
function validateZipEntries(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = bytes.length - 22
  while (end >= Math.max(0, bytes.length - 65557) && view.getUint32(end, true) !== 0x06054b50) end--
  if (end < 0 || end < bytes.length - 65557) throw new SkillInstallError('ZIP 缺少目录记录')
  const count = view.getUint16(end + 10, true)
  let offset = view.getUint32(end + 16, true)
  if (count === 65535 || offset === 0xffffffff) throw new SkillInstallError('技能导入不支持 ZIP64')
  const paths = new Set<string>()
  for (let i = 0; i < count; i++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50)
      throw new SkillInstallError('ZIP 目录记录损坏')
    const length = view.getUint16(offset + 28, true)
    const name = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(offset + 46, offset + 46 + length),
    )
    const path = zipPath(name).replace(/\/$/, '').toLowerCase()
    const mode = (view.getUint32(offset + 38, true) >>> 16) & 0xf000
    if (mode !== 0 && mode !== 0x8000 && mode !== 0x4000)
      throw new SkillInstallError(`ZIP 含链接或特殊文件：${name}`)
    if (paths.has(path)) throw new SkillInstallError(`ZIP 条目重名：${name}`)
    paths.add(path)
    offset += 46 + length + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true)
  }
}

export interface SkillImportResult {
  ok: boolean
  installed: SkillReceipt[]
  failures: { source: string; kind: 'invalid' | 'conflict' | 'cleanup'; error: string }[]
}

export async function importSkills(
  workspace: string,
  scope: WritableScope,
  source: string,
  replace = false,
): Promise<SkillImportResult> {
  const result: SkillImportResult = { ok: false, installed: [], failures: [] }
  let temporary: string | null = null
  try {
    let root = resolve(source)
    const info = await lstat(root)
    if (info.isFile()) {
      if (!root.toLowerCase().endsWith('.zip'))
        throw new SkillInstallError('技能包必须是目录或 ZIP')
      if (info.size > 128 * 1024 * 1024) throw new SkillInstallError('ZIP 超过 128 MiB 导入上限')
      const bytes = await readFile(root)
      validateZipEntries(bytes)
      let total = 0
      const files = unzipSync(bytes, {
        filter: (file) => {
          zipPath(file.name)
          total += file.originalSize
          if (total > 256 * 1024 * 1024)
            throw new SkillInstallError('ZIP 展开内容超过 256 MiB 导入上限')
          return true
        },
      })
      const parent = dirname(skillLayerRoot(workspace, scope))
      await mkdir(parent, { recursive: true })
      temporary = await mkdtemp(join(parent, '.skill-unpack-'))
      root = temporary
      for (const [name, data] of Object.entries(files)) {
        const dest = join(root, name)
        if (name.endsWith('/')) await mkdir(dest, { recursive: true })
        else {
          await mkdir(dirname(dest), { recursive: true })
          await writeFile(dest, data)
        }
      }
    } else if (!info.isDirectory()) throw new SkillInstallError('技能来源必须是普通目录或 ZIP')
    await inspectTree(root)
    const sources = await discover(root)
    if (!sources.length) throw new SkillInstallError('包内没有 SKILL.md')
    const seen = new Set<string>()
    for (const dir of sources) {
      try {
        const meta = await validateSkillDirectory(dir)
        const key = skillDirectoryName(dir === temporary ? meta.name : basename(dir))
        if (seen.has(key) || seen.has(`name:${meta.name}`))
          throw new SkillInstallError(`包内技能重名：${meta.name}`, 'conflict')
        seen.add(key)
        seen.add(`name:${meta.name}`)
        const receipt = await commitSkillDirectory(workspace, scope, key, replace, (stage) =>
          cp(dir, stage, { recursive: true, errorOnExist: true, force: false }),
        )
        result.installed.push(receipt)
        if (receipt.cleanupError)
          result.failures.push({ source, kind: 'cleanup', error: receipt.cleanupError })
      } catch (error) {
        result.failures.push({
          source: dir,
          kind: error instanceof SkillInstallError ? error.kind : 'invalid',
          error: String(error),
        })
      }
    }
  } catch (error) {
    result.failures.push({
      source,
      kind: error instanceof SkillInstallError ? error.kind : 'invalid',
      error: String(error),
    })
  } finally {
    if (temporary) {
      try {
        await rm(temporary, { recursive: true, force: true })
      } catch (error) {
        result.failures.push({
          source: temporary,
          kind: 'cleanup',
          error: `技能导入结果已保留，解包目录清理失败：${String(error)}`,
        })
      }
    }
  }
  result.ok = result.failures.length === 0 && result.installed.length > 0
  return result
}
