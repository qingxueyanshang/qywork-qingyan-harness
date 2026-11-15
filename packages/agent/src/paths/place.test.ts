/**
 * 覆盖范围：`paths/place.ts`（路径位置的判定，命令裁决与文件工具共用）。
 * 家目录均显式传入，Windows 写法与 POSIX 写法的用例在任何平台上结论相同。
 */
import { describe, expect, test } from 'bun:test'
import { isAbsolutePath, isOutsideRelative, placePath } from './place.ts'

const WIN_HOME = 'C:\\Users\\x'
const WIN_WS = 'C:\\Users\\x\\a\\ws'
const POSIX_HOME = '/home/u'
const POSIX_WS = '/home/u/a/ws'

const placeOf = (cwd: string, path: string, home: string, roots: readonly string[] = [cwd]) =>
  placePath(cwd, path, roots, home).place

describe('相对路径先消去 .. 再判定', () => {
  test('两级 .. 回到家目录：Windows 写法与 POSIX 写法', () => {
    expect(placeOf(WIN_WS, '../..', WIN_HOME)).toBe('home-or-system')
    expect(placeOf(WIN_WS, '..\\..\\.qywork\\config.json', WIN_HOME)).toBe('home-or-system')
    expect(placeOf(POSIX_WS, '../../.qywork/config.json', POSIX_HOME)).toBe('home-or-system')
    expect(placePath(POSIX_WS, '../..', [POSIX_WS], POSIX_HOME).path).toBe(POSIX_HOME)
  })

  test('含 .. 的绝对路径按消去后的位置判定', () => {
    expect(placeOf(POSIX_WS, `${POSIX_WS}/../../.qywork`, POSIX_HOME)).toBe('home-or-system')
    expect(placeOf(WIN_WS, `${WIN_WS}\\..\\..\\.qywork`, WIN_HOME)).toBe('home-or-system')
    expect(placeOf(POSIX_WS, '/etc/../home/u/x', POSIX_HOME)).toBe('home-or-system')
  })

  test('留在根目录内的 .. 仍是根目录', () => {
    expect(placeOf(WIN_WS, 'sub/../build', WIN_HOME)).toBe('root')
    expect(placeOf(POSIX_WS, './sub/./x', POSIX_HOME)).toBe('root')
  })

  test('以两个点开头的名称位于根目录内', () => {
    expect(placeOf(POSIX_WS, '..cache/a.txt', POSIX_HOME)).toBe('root')
    expect(placeOf(WIN_WS, '..cache\\a.txt', WIN_HOME)).toBe('root')
  })
})

describe('三种位置', () => {
  test('额外目录与工作区同为根目录，先于家目录判定', () => {
    const extra = 'C:\\Users\\x\\data'
    expect(placeOf(WIN_WS, 'C:/Users/x/data/out.txt', WIN_HOME, [WIN_WS, extra])).toBe('root')
    expect(placeOf(WIN_WS, 'C:/Users/x/other/out.txt', WIN_HOME, [WIN_WS, extra])).toBe(
      'home-or-system',
    )
  })

  test('系统目录：/etc 与任一盘符的 Windows 目录', () => {
    expect(placeOf(POSIX_WS, '/etc/hosts', POSIX_HOME)).toBe('home-or-system')
    expect(placeOf(WIN_WS, 'D:\\Windows\\System32', WIN_HOME)).toBe('home-or-system')
  })

  test('家目录与系统目录之外：其他盘符、其他目录', () => {
    expect(placeOf(WIN_WS, 'D:/other-project/a.txt', WIN_HOME)).toBe('other')
    expect(placeOf(WIN_WS, 'C:/ProgramData/x.txt', WIN_HOME)).toBe('other')
    expect(placeOf('/ws', '../sibling', POSIX_HOME)).toBe('other')
    expect(placeOf(POSIX_WS, '/var/data/a.txt', POSIX_HOME)).toBe('other')
  })

  /** 删除上级目录即删除其中的家目录。 */
  test('包含家目录的位置：家目录的上级，以及家目录所在的 / 或盘符根目录', () => {
    expect(placeOf(WIN_WS, 'C:/Users', WIN_HOME)).toBe('home-or-system')
    expect(placeOf(WIN_WS, '../../..', WIN_HOME)).toBe('home-or-system')
    expect(placeOf(WIN_WS, 'C:\\', WIN_HOME)).toBe('home-or-system')
    expect(placeOf(POSIX_WS, '/home', POSIX_HOME)).toBe('home-or-system')
    expect(placeOf(POSIX_WS, '/', POSIX_HOME)).toBe('home-or-system')
  })

  /** 系统目录只判定「位于其中」：按任一盘符判定的系统目录不使其他盘符的根目录被拒绝。 */
  test('只包含系统目录、不包含家目录的位置是其他位置', () => {
    expect(placeOf(WIN_WS, 'D:\\', WIN_HOME)).toBe('other')
    expect(placeOf(WIN_WS, 'D:/', WIN_HOME)).toBe('other')
    expect(placeOf(POSIX_WS, '/', 'C:\\Users\\x')).toBe('other')
  })

  test('位于家目录的上级之中、不包含家目录的位置仍是其他位置', () => {
    expect(placeOf(WIN_WS, 'C:/Users/Public/a.txt', WIN_HOME)).toBe('other')
    expect(placeOf(POSIX_WS, '/home/other-user/a.txt', POSIX_HOME)).toBe('other')
  })

  /** 根目录本身与其同级目录都可写，二者的上级同样按其他位置处理。 */
  test('只包含根目录、不包含家目录与系统目录的位置是其他位置', () => {
    expect(placeOf('/ws/project', '..', POSIX_HOME)).toBe('other')
  })

  test('写法不同的路径互不包含：POSIX 工作区与 Windows 家目录', () => {
    expect(placeOf('/ws', 'C:/Users/x/notes.txt', WIN_HOME)).toBe('home-or-system')
    expect(placeOf('/ws', 'C:/Windows/x', POSIX_HOME)).toBe('home-or-system')
    expect(placeOf('C:\\ws', '/etc/hosts', WIN_HOME)).toBe('home-or-system')
    expect(placeOf('/ws', 'dist', WIN_HOME)).toBe('root')
  })

  test('Windows 写法的路径不区分大小写', () => {
    expect(placeOf(WIN_WS, 'c:/users/X/.qywork/config.json', WIN_HOME)).toBe('home-or-system')
    expect(placeOf(WIN_WS, 'c:/USERS/X/A/WS/src', WIN_HOME)).toBe('root')
  })

  test('家目录为空时只按根目录与系统目录判定', () => {
    expect(placeOf(POSIX_WS, '/home/u/x', '')).toBe('other')
    expect(placeOf(POSIX_WS, '/etc/x', '')).toBe('home-or-system')
  })
})

test('绝对路径的判定与平台无关', () => {
  for (const p of ['/x', '\\x', 'C:/x', 'c:\\x', '\\\\srv\\share'])
    expect(isAbsolutePath(p)).toBe(true)
  for (const p of ['x', './x', '..', 'C:x', '~/x']) expect(isAbsolutePath(p)).toBe(false)
})

test('relative 结果中只有完整的 .. 段与绝对路径表示越出', () => {
  for (const rel of ['..', '../x', '..\\x', 'D:\\x', '\\\\srv\\share']) {
    expect(isOutsideRelative(rel)).toBe(true)
  }
  for (const rel of ['', 'a', '..cache', '..cache/a', '...', 'a/..b']) {
    expect(isOutsideRelative(rel)).toBe(false)
  }
})
