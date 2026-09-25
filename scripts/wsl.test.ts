/** 覆盖 `wsl.ts` 的参数解析（ref 缺省、`run` 的 `--` 分隔与非法组合）与检出目录的取值。不启动 WSL。 */
import { describe, expect, test } from 'bun:test'
import { checkoutDir, parseArgs } from './wsl.ts'

describe('WSL 检出目录', () => {
  test('缺省为 qywork-wsl，QYWORK_WSL_DIR 给了就用它', () => {
    expect(checkoutDir({})).toBe('qywork-wsl')
    expect(checkoutDir({ QYWORK_WSL_DIR: '' })).toBe('qywork-wsl')
    expect(checkoutDir({ QYWORK_WSL_DIR: 'qywork-b1' })).toBe('qywork-b1')
    expect(checkoutDir({ QYWORK_WSL_DIR: '/srv/qy' })).toBe('/srv/qy')
  })
})

describe('WSL 入口的参数解析', () => {
  test('gate 的 ref 缺省为 HEAD', () => {
    expect(parseArgs(['gate'])).toEqual({ kind: 'gate', ref: 'HEAD' })
    expect(parseArgs(['gate', 'abc123'])).toEqual({ kind: 'gate', ref: 'abc123' })
  })

  test('run 以第一个 -- 分隔 ref 与命令，其后的 -- 属于命令', () => {
    expect(parseArgs(['run', '--', 'python3', 'x.py'])).toEqual({
      kind: 'run',
      ref: 'HEAD',
      argv: ['python3', 'x.py'],
    })
    expect(parseArgs(['run', 'master', '--', 'sh', '--', 'a'])).toEqual({
      kind: 'run',
      ref: 'master',
      argv: ['sh', '--', 'a'],
    })
  })

  test('缺分隔符、缺命令、多余参数与未知子命令都拒绝', () => {
    for (const args of [
      [],
      ['build'],
      ['gate', 'a', 'b'],
      ['run', 'python3'],
      ['run', '--'],
      ['run', 'a', 'b', '--', 'c'],
    ]) {
      expect(() => parseArgs(args)).toThrow('用法')
    }
  })
})
