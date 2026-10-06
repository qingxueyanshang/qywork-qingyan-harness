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
 * 本机当前阻塞于哪一步。
 *
 * 三项能力位依次成立，只显示第一个不成立的步骤：若三项各占一行，
 * 宿主未连接时后两行也会显示「未连接」，同一信息重复显示三次。授权事实由 worker 报告，
 * 因此组件未就绪排在系统未授权之前。
 */
export function desktopStatus(d: DesktopCapability | undefined): string {
  if (!d) return '读取中…'
  if (!d.connected) return '宿主未连接'
  if (!d.workerReady) return '组件未就绪'
  if (!d.authorized) return '系统未授权'
  return '已就绪'
}

/**
 * 缺项在界面上的名称与状态文字。`pane` 为真的两项在系统设置中有对应的页面，
 * 由外壳按名称打开。
 */
const GRANTS: Record<DesktopGrant, { label: string; value: string; pane: boolean }> = {
  accessibility: { label: '辅助功能', value: '未授权', pane: true },
  screen_recording: { label: '屏幕录制', value: '未授权', pane: true },
  accessibility_bus: { label: '无障碍总线', value: '不可用', pane: false },
}

/** 浏览器控制当前阻塞于哪一步。宿主已连接但没有浏览器时显示原因，版本不达标时手动浏览仍可用。 */
function browserStatus(): string {
  const b = state.capabilities?.browser
  if (!b) return '读取中…'
  if (b.connected) return b.runtimeSupported ? '已就绪' : '浏览器版本过低'
  return browserUnavailableText() ?? '宿主未连接'
}

/**
 * 权限：agent 可读写的路径、名称形似凭证但仍需放行的环境变量、能否操作本机上的
 * 其他应用。
 *
 * 审批模式（自动审批 / 完全访问）不在本页，位于输入区的 chip 上：它决定的是
 * 下一轮能否无需确认直接执行，与模型选择属于同一层级，需要随时修改。移入设置后每次修改
 * 需要点击四次，且两处修改同一字段会形成两套账。
 *
 * 沙箱同样不在本页。沙箱决定命令在何种隔离环境中运行，而不是是否准许访问；
 * 其状态常驻显示在左栏角落，详情位于「模块 → 终端」。本页只涉及权限。
 */
export function AccessSettings() {
  ensureConfig()
  // 外壳未能打开系统设置的项。只记录最近一次：再次点击时清除并重试。
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
          {/* 两个字段合在一张卡片中，不设小标题：页标题已是「权限」，
                再加一行说明 agent 可访问范围的标题属于重复显示。 */}
          <section class="settings-block">
            <div class="setting-rows">
              {/* 「完全访问」的边界说明位于页头（`SettingsNav` 的 `desc`），与其他页一致；
                    不要写成「完全访问下同样受限」，这与实现相反：`session.ts` 在该模式下
                    传入 `unrestrictedPaths`，完全不设路径层。
                    「只接受绝对路径」不写入说明，占位符中已包含该信息。 */}
              <Field label="工作区之外额外可读写的目录">
                {/*
                    多行清单使用 blur 提交，不使用 onInput。
                    每次写入都会立即切换运行中的配置，逐键写入会把「C:\」这类不完整的路径
                    逐次提交；且一行尚未输入完成时空行即被 trim 删除，光标位置会跳变。
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
                    是机制，不是用户在该字段中要做的决定；写入界面即属于解释性文本（B7）。
                    占位符是留空时生效的默认清单，由服务端下发；写死在前端会形成第二套账。 */}
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

          {/* 电脑控制单独一张卡片：它管理的不是路径，而是 agent 能否操作本机上的其他应用。
                整组的开关不在本页，位于「模块 → 电脑控制」的分组标题，同一开关只放一处。
                本页保留会占用真实鼠标键盘的前台操作开关，以及本机当前的实际状态。 */}
          <section class="settings-block">
            <h3 class="settings-block-head">电脑控制</h3>
            <div class="setting-rows">
              {/* 该提示是边界而非说明：界面上没有第二处能说明开启后 agent 会占用
                    鼠标键盘。关闭时桌面工具仍可用，但只保留不占用鼠标键盘的操作。 */}
              <Row label="前台操作" hint="使用真实鼠标键盘，执行时会中断当前操作">
                <OnOff
                  on={c().desktopForeground !== false}
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
                    {/* 按钮只在桌面外壳中提供：打开系统设置是外壳的命令，手机与浏览器中无法调用。 */}
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
