import type { DesktopCapability, DesktopGrant } from '@qywork/core'
import { createSignal, For, Show } from 'solid-js'
import {
  browserUnavailableText,
  isDesktopShell,
  state,
  tauriInvoke,
} from '../../lib/store/index.ts'
import { ConfigStatus } from './ConfigStatus.tsx'
import {
  config,
  configError,
  defaultEnvAllowList,
  ensureConfig,
  patchConfig,
  reloadConfig,
} from './configStore.ts'
import { LoadState } from './LoadState.tsx'
import { OnOff } from './OnOff.tsx'
import { Field, Row } from './Row.tsx'

/**
 * 这台机器此刻卡在哪一步。
 *
 * 三项能力位依次成立，只报第一个不成立的那一步：三项各占一行的话，
 * 宿主没连上时后两行都会写「未连接」，同一件事印三遍。授权事实由 worker 报，
 * 所以组件未就绪排在系统未授权前面。
 */
export function desktopStatus(d: DesktopCapability | undefined): string {
  if (!d) return '读取中…'
  if (!d.connected) return '宿主未连接'
  if (!d.workerReady) return '组件未就绪'
  if (!d.authorized) return '系统未授权'
  return '已就绪'
}

/**
 * 缺项在界面上的名字与状态词。`pane` 为真的那两项在系统设置里有对应的一页，
 * 由外壳按名字打开。
 */
const GRANTS: Record<DesktopGrant, { label: string; value: string; pane: boolean }> = {
  accessibility: { label: '辅助功能', value: '未授权', pane: true },
  screen_recording: { label: '屏幕录制', value: '未授权', pane: true },
  accessibility_bus: { label: '无障碍总线', value: '不可用', pane: false },
}

/** 浏览器控制此刻卡在哪一步。宿主连着却没有浏览器时报原因，版本不达标时手动浏览仍可用。 */
function browserStatus(): string {
  const b = state.capabilities?.browser
  if (!b) return '读取中…'
  if (b.connected) return b.runtimeSupported ? '已就绪' : '浏览器版本过低'
  return browserUnavailableText() ?? '宿主未连接'
}

/**
 * 权限：agent 能读写哪些路径、哪些名字像凭证的环境变量仍要放行、能不能操作本机上
 * 别的应用。
 *
 * 审批模式（自动审批 / 完全访问）**不在这里**。它在输入区那个 chip 上——决定的是
 * 下一轮能不能不问就动手，和「用哪个模型」同一层，随时要改。搬进设置意味着改一次
 * 点四下，而且两处都能改同一个字段就是两本账。
 *
 * **沙箱也不在这里。** 沙箱是「命令跑在什么隔离里」，不是「准不准碰」——
 * 它的状态在左栏角落常驻，详情在「模块 → 终端」。这一页只回答权限。
 */
export function AccessSettings() {
  ensureConfig()
  // 外壳没能打开系统设置的那一项。只记最近一次：再点一次即清掉重试。
  const [openFailed, setOpenFailed] = createSignal<DesktopGrant | null>(null)
  const openSettings = (grant: DesktopGrant) => {
    setOpenFailed(null)
    tauriInvoke('desktop_open_settings', { grant }).catch(() => setOpenFailed(grant))
  }

  return (
    <Show
      when={config()}
      fallback={<LoadState error={configError()} onRetry={() => void reloadConfig()} />}
    >
      {(c) => (
        <>
          {/* 两格合在一张卡里，**不开小标题**：页标题已经是「权限」，
                再来一行「agent 能碰到什么」就是同一件事写两遍。 */}
          <section class="settings-block">
            <div class="setting-rows">
              {/* 「完全访问」那条边界在页头（`SettingsNav` 的 `desc`），与别的页一致；
                    **不要写成「完全访问下同样受限」**，那与实现相反：`session.ts` 在该模式下
                    传 `unrestrictedPaths`，路径层整个不设。
                    「只接受绝对路径」不写进说明——占位符里已经有了。 */}
              <Field label="工作区之外额外可读写的目录">
                {/*
                    多行清单**用 blur 提交，不用 onInput**。
                    每次写都会立即切换运行中的配置，逐键写等于把「C:\」这种半截路径
                    逐次提交；而且一行还没敲完就被 trim 掉空行，光标会跳。
                  */}
                <textarea
                  rows={10}
                  placeholder="一行一个绝对路径"
                  value={(c().additionalDirectories ?? []).join('\n')}
                  onBlur={(e) =>
                    void patchConfig({ additionalDirectories: lines(e.currentTarget.value) })
                  }
                />
              </Field>

              {/* 不写说明行。`scrubEnv` 的判据优先级（值命中 > 白名单 > 名称模式）
                    是机制，不是用户在这一格要做的决定；写进界面就是解释性文本（B7）。
                    占位符是留空时生效的那一份，由服务端下发——写死就是第二本账。 */}
              <Field label="环境变量白名单">
                <textarea
                  rows={10}
                  placeholder={defaultEnvAllowList().join('\n')}
                  value={(c().envAllowList ?? []).join('\n')}
                  onBlur={(e) => void patchConfig({ envAllowList: lines(e.currentTarget.value) })}
                />
              </Field>
            </div>
          </section>

          {/* 电脑控制单开一张卡：它管的不是路径，而是 agent 能不能操作本机上别的应用。
                **整组的开关不在这里**，在「模块 → 电脑控制」的组头，同一个开关只放一处。
                留在这一页的是会占用真实鼠标键盘的那一半，和这台机器此刻的实际状态。 */}
          <section class="settings-block">
            <h3 class="settings-block-head">电脑控制</h3>
            <div class="setting-rows">
              {/* 这一句是边界不是说明：界面上没有第二处说得出「开了之后 agent 会占用
                    鼠标键盘」。关着时桌面工具仍然可用，只是只剩不打扰的那一半。 */}
              <Row label="前台操作" hint="用真实鼠标键盘，执行时会打断你">
                <OnOff
                  on={c().desktopForeground === true}
                  onPick={(on) => void patchConfig({ desktopForeground: on })}
                />
              </Row>
              <Row label="状态">
                <span class="setting-row-hint">{desktopStatus(state.capabilities?.desktop)}</span>
              </Row>
              <For each={state.capabilities?.desktop.missing ?? []}>
                {(grant) => (
                  <Row
                    label={GRANTS[grant].label}
                    hint={openFailed() === grant ? '无法打开系统设置' : GRANTS[grant].value}
                  >
                    {/* 按钮只在桌面外壳里给：打开系统设置是外壳的命令，手机与浏览器里调不到。 */}
                    <Show when={GRANTS[grant].pane && isDesktopShell()}>
                      <button
                        class="btn-ghost sm"
                        type="button"
                        onClick={() => openSettings(grant)}
                      >
                        打开系统设置
                      </button>
                    </Show>
                  </Row>
                )}
              </For>
            </div>
          </section>

          <section class="settings-block">
            <h3 class="settings-block-head">浏览器控制</h3>
            <div class="setting-rows">
              <Row label="状态">
                <span class="setting-row-hint">{browserStatus()}</span>
              </Row>
            </div>
          </section>

          <ConfigStatus />
        </>
      )}
    </Show>
  )
}

function lines(v: string): string[] {
  return v
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}
