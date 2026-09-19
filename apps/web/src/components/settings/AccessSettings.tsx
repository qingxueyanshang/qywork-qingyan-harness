import { For, Show } from 'solid-js'
import { state } from '../../lib/store/index.ts'
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
import { Field, Row } from './Row.tsx'

const SWITCH = [
  { on: false, label: '关闭' },
  { on: true, label: '启用' },
]

/**
 * 这台机器此刻卡在哪一步。
 *
 * 三项能力位依次成立，只报第一个不成立的那一步：三项各占一行的话，
 * 宿主没连上时后两行都会写「未连接」，同一件事印三遍。
 */
function desktopStatus(): string {
  const d = state.capabilities?.desktop
  if (!d) return '读取中…'
  if (!d.connected) return '宿主未连接'
  if (!d.authorized) return '系统未授权'
  if (!d.workerReady) return '组件未就绪'
  return '已就绪'
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

          {/* 电脑操作单开一张卡：它管的不是路径，而是 agent 能不能操作本机上别的应用。
                三行——用户改得了的两项，和这台机器此刻的实际状态。 */}
          <section class="settings-block">
            <h3 class="settings-block-head">电脑操作</h3>
            <div class="setting-rows">
              <Row label="启用">
                <Switch
                  on={c().desktopEnabled === true}
                  onPick={(on) => void patchConfig({ desktopEnabled: on })}
                />
              </Row>
              {/* 这一句是边界不是说明：界面上没有第二处说得出「开了之后 agent 会占用
                    鼠标键盘」。关着时桌面工具仍然可用，只是只剩不打扰的那一半。 */}
              <Row label="前台操作" hint="用真实鼠标键盘，执行时会打断你">
                <Switch
                  on={c().desktopForeground === true}
                  onPick={(on) => void patchConfig({ desktopForeground: on })}
                />
              </Row>
              <Row label="状态">
                <span class="setting-row-hint">{desktopStatus()}</span>
              </Row>
            </div>
          </section>

          <ConfigStatus />
        </>
      )}
    </Show>
  )
}

/** 两格开关。这张卡上有两项同形的开关，写两遍的代价是改一处忘另一处。 */
function Switch(props: { on: boolean; onPick: (on: boolean) => void }) {
  return (
    <div class="seg">
      <For each={SWITCH}>
        {(o) => (
          <button
            class="seg-item"
            classList={{ active: props.on === o.on }}
            type="button"
            onClick={() => props.onPick(o.on)}
          >
            {o.label}
          </button>
        )}
      </For>
    </div>
  )
}

function lines(v: string): string[] {
  return v
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}
