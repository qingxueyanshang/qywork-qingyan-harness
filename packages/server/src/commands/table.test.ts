/**
 * 覆盖范围：`commands.ts` 的 `handleCommand` 按 `commands/table.ts` 的总表分派时，协议外的指令类型
 * （含 `constructor` 等对象原型上的键与缺少类型）一律以 `unknown_command` 回执。
 */

import { expect, test } from 'bun:test'
import { handleCommand } from '../commands.ts'

function socket() {
  const sent: unknown[] = []
  return {
    sent,
    ws: {
      data: { authed: true, id: 'c1', origin: 'cli' },
      send: (raw: string) => sent.push(JSON.parse(raw)),
    } as never,
  }
}

/** 类型来自网络：按普通对象取值时，原型上的键会取到对象自带的成员，指令没有回执。 */
test('协议外的指令类型以 unknown_command 回执，原型上的键与缺少类型同样如此', async () => {
  for (const [cmd, command] of [
    [{ type: 'no.such' }, 'no.such'],
    [{ type: 'constructor' }, 'constructor'],
    [{ type: 'toString' }, 'toString'],
    [{ type: '__proto__' }, '__proto__'],
    [{}, '(missing)'],
  ] as const) {
    const sock = socket()
    await handleCommand(cmd as never, { ws: sock.ws, runs: { updating: false } } as never)
    expect(sock.sent).toEqual([
      {
        type: 'command.rejected',
        command,
        reason: 'unknown_command',
        message: '服务端无法识别该指令',
      },
    ])
  }
})
