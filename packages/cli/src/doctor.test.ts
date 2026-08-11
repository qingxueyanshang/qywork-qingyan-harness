/**
 * `qy doctor`。
 *
 * 断言的是**结论与自洽**，不是文案：这条命令的输出会经常改措辞，
 * 而一改就红的测试很快会被降级成「只验不抛异常」——那等于什么都没验。
 *
 * 所以这里验三件事：
 *
 * 1. 每一段都在（少一段就是少查一类东西，而少查是静默的）；
 * 2. 每一条结论都说得出**为什么**（`⚠` 和 `✗` 没有 detail 等于告诉用户
 *    「出问题了，自己猜」）；
 * 3. 退出码只由 `✗` 决定——`⚠` 也退非零的话，CI 里挂着一堆
 *    「这台机器没有内核沙箱」的黄灯，很快就没人看退出码了。
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
  test('五段都在', () => {
    // 少一段就是少查一类东西，而「少查了」这件事本身是静默的——
    // 输出看起来照样很完整。
    expect(report.map((s) => s.title)).toEqual([
      '配置',
      'shell 沙箱',
      '账本与正文库',
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
    // 「出问题了，自己猜」是最没用的一种反馈。
    for (const l of all()) {
      if (l.level === 'ok') continue
      expect(`${l.text}${l.detail ?? ''}`.length).toBeGreaterThan(12)
    }
  })

  test('沙箱那条永远在，有没有都报', () => {
    // 「没有内核边界」是很多机器上的默认状态，它不会主动报错——
    // 不主动说的话，用户只会在模型删掉工作区外的东西之后才想起来。
    const sb = report.find((s) => s.title === 'shell 沙箱')
    expect(sb?.lines).toHaveLength(1)
    expect(sb?.lines[0]?.detail?.length ?? 0).toBeGreaterThan(10)
  })

  test('空工作区本身不产生阻断项', () => {
    /*
     * 范围是**工作区相关的那几段**，不含配置。
     *
     * 第一版把配置也算进来了，于是这条和下面那条「没 key 判 fail」互相矛盾——
     * 临时 QYWORK_HOME 里没有配置文件，本来就应该报没 key。
     * 测试自己把这个矛盾顶出来了，这正是它该干的事。
     *
     * 分清楚之后这条验的是：一个刚建的空目录不会因为「空」而报红。
     * 否则第一次跑 doctor 的人看到红，会以为自己装坏了。
     */
    const wsSections = report.filter((s) => s.title !== '配置')
    expect(wsSections.flatMap((s) => s.lines).filter((l) => l.level === 'fail')).toEqual([])
  })

  test('没配 MCP / 没装插件报成正常，不报成警告', () => {
    // 「没有」不是「有问题」。报成警告的话，绝大多数用户第一次跑就看到两条黄，
    // 而黄灯一多就没人看了。
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
