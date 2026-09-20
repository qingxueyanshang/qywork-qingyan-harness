/**
 * 电脑控制协议版本的跨语言一致性。**覆盖范围**：
 * `apps/desktop/native/computer-host/src/protocol_version.rs` 与
 * `packages/core/src/protocol/native-desktop.ts` 的 `DESKTOP_PROTOCOL_VERSION`。
 *
 * 宿主在 `host.ready` 里上报 Rust 那个数，服务端按 TS 那个数核对，不一致即不注册宿主，
 * 电脑控制整组工具随之不出现。两侧无法共用一份源文件，由本测试在门禁里比对。
 */

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DESKTOP_PROTOCOL_VERSION } from '@qywork/core'

const RUST_FILE = join(
  import.meta.dir,
  '..',
  'apps/desktop/native/computer-host/src/protocol_version.rs',
)

test('服务端核对的协议版本等于宿主上报的那个数', () => {
  const match = /pub const PROTOCOL_VERSION: u32 = (\d+);/.exec(readFileSync(RUST_FILE, 'utf8'))
  expect(match).not.toBeNull()
  expect(DESKTOP_PROTOCOL_VERSION).toBe(Number(match?.[1]))
})
