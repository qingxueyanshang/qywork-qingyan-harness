/**
 * 桌面宿主的测试替身。
 *
 * 两份测试共用（`bridge.test.ts` 与 `assembly.test.ts`），所以单独一个文件：互相 import
 * 测试文件会让其中一份的用例被注册两遍。这里不含用例，只有夹具。
 */

import type {
  DesktopHostReadyFrame,
  DesktopRequestFrame,
  DesktopResultFrame,
  DesktopWindow,
  NativeDesktopUpFrame,
} from '@qywork/core'
import { NATIVE_DESKTOP_PATH, NATIVE_HOST_KEY_HEADER } from '@qywork/core'

export const HOST_KEY = 'desktop-host-key-for-tests'

export const READY: DesktopHostReadyFrame = {
  type: 'host.ready',
  hostId: 'h1',
  hostEpoch: 2,
  connectionEpoch: 3,
  platform: 'windows',
  workerReady: true,
  authorized: true,
  missing: [],
}

export const WINDOW: DesktopWindow = {
  handle: 66,
  pid: 900,
  processStartedAt: 1_700_000_000_000,
  app: '记事本',
  title: '未命名',
}

/** 假宿主：一条真 WebSocket，按需回帧。 */
export class FakeDesktopHost {
  socket: WebSocket
  received: DesktopRequestFrame[] = []
  #waiters: ((frame: DesktopRequestFrame) => void)[] = []

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.onmessage = (ev) => {
      const frame = JSON.parse(String(ev.data)) as DesktopRequestFrame
      this.received.push(frame)
      this.#waiters.shift()?.(frame)
    }
  }

  /** `closers` 由调用方在收尾时逐条执行；夹具自己不挂 `afterEach`。 */
  static async connect(
    port: number,
    key: string,
    closers: (() => void)[],
  ): Promise<FakeDesktopHost> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${NATIVE_DESKTOP_PATH}`, {
      headers: { [NATIVE_HOST_KEY_HEADER]: key },
    })
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve()
      socket.onclose = () => reject(new Error('宿主连接被拒'))
      socket.onerror = () => reject(new Error('宿主连接失败'))
    })
    const host = new FakeDesktopHost(socket)
    closers.push(() => host.socket.close())
    return host
  }

  send(frame: NativeDesktopUpFrame): void {
    this.socket.send(JSON.stringify(frame))
  }

  ready(over: Partial<DesktopHostReadyFrame> = {}): void {
    this.send({ ...READY, ...over })
  }

  next(): Promise<DesktopRequestFrame> {
    return new Promise((resolve) => this.#waiters.push(resolve))
  }

  /** 按一条请求回一份观察。代际字段默认照抄请求，用例可以逐项改坏。 */
  reply(frame: DesktopRequestFrame, over: Partial<DesktopResultFrame> = {}): void {
    this.send({
      type: 'desktop.result',
      requestId: frame.requestId,
      connectionEpoch: frame.connectionEpoch,
      hostId: frame.hostId,
      hostEpoch: frame.hostEpoch,
      dispatch: 'not_dispatched',
      observation: { kind: 'windows', capturedAt: 1, windows: [WINDOW] },
      ...over,
    })
  }

  /** 只回执行事实，不带观察。撤销回执与动作回执用它。 */
  settle(frame: DesktopRequestFrame, dispatch: DesktopResultFrame['dispatch']): void {
    this.send({
      type: 'desktop.result',
      requestId: frame.requestId,
      connectionEpoch: frame.connectionEpoch,
      hostId: frame.hostId,
      hostEpoch: frame.hostEpoch,
      dispatch,
    })
  }
}
