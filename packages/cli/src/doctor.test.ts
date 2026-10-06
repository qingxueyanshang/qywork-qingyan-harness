/**
 * `qy doctor`。
 *
 * 断言的是**结论与自洽性**，不是文案：输出措辞会变化，绑定文案的断言最终会被弱化为
 * 「只验证不抛异常」。
 *
 * 因此这里验证三件事：
 *
 * 1. 每一段都存在（缺少一段即少检查一类状态，且缺失不产生任何提示）；
 * 2. 每一条非正常结论都说明**原因**（`⚠` 和 `✗` 没有 detail 时，用户只能
 *    自行推测原因）；
 * 3. 退出码只由 `✗` 决定：若 `⚠` 也返回非零，无内核沙箱的机器上退出码恒为非零。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectDoctorReport, type Section } from './doctor.ts'

let home = ''
let ws = ''
let report: Section[] = []
const prevHome = process.env.QYWORK_HOME

beforeAll(async () => {
  // 指向临时目录：体检会在配置目录中写入一个探针文件，不得写入用户实际的 ~/.qywork。
  home = await mkdtemp(join(tmpdir(), 'qy-doctor-home-'))
  ws = await mkdtemp(join(tmpdir(), 'qy-doctor-ws-'))
  process.env.QYWORK_HOME = home
  report = await collectDoctorReport(ws)
})

afterAll(async () => {
  if (prevHome === undefined) delete process.env.QYWORK_HOME
  else process.env.QYWORK_HOME = prevHome
  await rm(home, { recursive: true, force: true }).catch(() => {})
  await rm(ws, { recursive: true, force: true }).catch(() => {})
})

const all = () => report.flatMap((s) => s.lines)

describe('体检覆盖范围', () => {
  test('六段均存在', () => {
    // 缺少一段即少检查一类状态，而缺段不会使输出显得不完整。
    expect(report.map((s) => s.title)).toEqual([
      '配置',
      'shell 沙箱',
      '账本与正文库',
      '请求完成率',
      'MCP',
      '插件',
    ])
  })

  test('每一段至少给出一条结论', () => {
    for (const s of report) expect(s.lines.length).toBeGreaterThan(0)
  })
})

describe('结论须可操作', () => {
  test('警告与失败必须说明原因', () => {
    // 没有 detail 的警告与失败不可操作。
    for (const l of all()) {
      if (l.level === 'ok') continue
      expect(`${l.text}${l.detail ?? ''}`.length).toBeGreaterThan(12)
    }
  })

  test('沙箱一项始终输出，无论是否具备沙箱', () => {
    // 无内核边界是多数机器的默认状态，且不产生任何错误信号，只能由体检主动报告。
    const sb = report.find((s) => s.title === 'shell 沙箱')
    expect(sb?.lines).toHaveLength(1)
    expect(sb?.lines[0]?.detail?.length ?? 0).toBeGreaterThan(10)
  })

  test('空工作区本身不产生阻断项', () => {
    /*
     * 范围是**与工作区相关的各段**，不含配置：临时 QYWORK_HOME 中没有配置文件，
     * 配置段应判定为 fail（见下方「没有 key 时配置段判定为 fail 而不是 warn」）。
     *
     * 本用例验证空目录不会因为「空」而报 fail：否则首次运行时的失败项会指向一个不存在的
     * 安装问题。
     */
    const wsSections = report.filter((s) => s.title !== '配置')
    expect(wsSections.flatMap((s) => s.lines).filter((l) => l.level === 'fail')).toEqual([])
  })

  test('未配置 MCP、未安装插件时报告为正常而不是警告', () => {
    // 「没有」不等于「有问题」。报告为警告会使首次运行默认带有两条 warn，削弱警告的提示作用。
    for (const title of ['MCP', '插件']) {
      const s = report.find((x) => x.title === title)
      expect(s?.lines.every((l) => l.level === 'ok')).toBe(true)
    }
  })
})

describe('等级判定', () => {
  test('只有三种等级', () => {
    for (const l of all()) expect(['ok', 'warn', 'fail']).toContain(l.level)
  })

  test('没有 key 时配置段判定为 fail 而不是 warn', async () => {
    // 没有 key 时无法发出任何请求，属于阻断而不是警告。
    // 若判定为 warn，`qy doctor` 在完全未配置的机器上会以 0 退出。
    const cfg = report.find((s) => s.title === '配置')
    expect(cfg).toBeDefined()
    // 本次运行使用临时 QYWORK_HOME，没有配置文件 → 使用默认配置 → 没有 key。
    expect(cfg?.lines.some((l) => l.level === 'fail')).toBe(true)
  })
})
