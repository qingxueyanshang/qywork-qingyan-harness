/**
 * `qy doctor`。
 *
 * 断言的是**结论与自洽**，不是文案：输出措辞会变，绑定文案的断言会被降级成
 * 「只验不抛异常」。
 *
 * 所以这里验三件事：
 *
 * 1. 每一段都在（少一段就是少查一类状态，而少查是静默的）；
 * 2. 每一条结论都说得出**为什么**（`⚠` 和 `✗` 没有 detail 等于告诉用户
 *    「出问题了，自己猜」）；
 * 3. 退出码只由 `✗` 决定：`⚠` 也退非零的话，无内核沙箱的机器上退出码恒为非零。
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
  // 指向临时目录：体检会往配置目录写一个探针文件，不能落到用户真的 ~/.qywork 里。
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

describe('体检覆盖面', () => {
  test('六段都在', () => {
    // 少一段就是少查一类状态，而缺段不会让输出显得不完整。
    expect(report.map((s) => s.title)).toEqual([
      '配置',
      'shell 沙箱',
      '账本与正文库',
      '端点收尾',
      'MCP',
      '插件',
    ])
  })

  test('每一段至少给出一条结论', () => {
    for (const s of report) expect(s.lines.length).toBeGreaterThan(0)
  })
})

describe('结论要可操作', () => {
  test('警告与失败必须说得出为什么', () => {
    // 没有 detail 的警告与失败不可操作。
    for (const l of all()) {
      if (l.level === 'ok') continue
      expect(`${l.text}${l.detail ?? ''}`.length).toBeGreaterThan(12)
    }
  })

  test('沙箱那条永远在，有没有都报', () => {
    // 无内核边界是多数机器的默认状态，且不产生任何错误信号，只能由体检主动报出。
    const sb = report.find((s) => s.title === 'shell 沙箱')
    expect(sb?.lines).toHaveLength(1)
    expect(sb?.lines[0]?.detail?.length ?? 0).toBeGreaterThan(10)
  })

  test('空工作区本身不产生阻断项', () => {
    /*
     * 范围是**工作区相关的那几段**，不含配置：临时 QYWORK_HOME 里没有配置文件，
     * 配置段本来就该判 fail（见下面「没有 key 时配置那段判 fail」）。
     *
     * 这条验的是空目录不因「空」而报 fail——否则首次运行的红项指向一个不存在的
     * 安装问题。
     */
    const wsSections = report.filter((s) => s.title !== '配置')
    expect(wsSections.flatMap((s) => s.lines).filter((l) => l.level === 'fail')).toEqual([])
  })

  test('没配 MCP / 没装插件报成正常，不报成警告', () => {
    // 「没有」不是「有问题」。报成警告会让首次运行默认带两条 warn，稀释警告的指示性。
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

  test('没有 key 时配置那段判 fail 而不是 warn', async () => {
    // 没有 key 就发不出任何请求——那是阻断，不是「需要知道」。
    // 判成 warn 的话 `qy doctor` 在一台完全没配好的机器上会退 0。
    const cfg = report.find((s) => s.title === '配置')
    expect(cfg).toBeDefined()
    // 本次跑在临时 QYWORK_HOME 上，没有配置文件 → 走默认档案 → 没有 key。
    expect(cfg?.lines.some((l) => l.level === 'fail')).toBe(true)
  })
})
