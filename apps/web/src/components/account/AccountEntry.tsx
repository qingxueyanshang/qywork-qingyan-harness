import type { CloudState } from '@qywork/core'
import { Show } from 'solid-js'
import { cloudState } from '../../lib/store/cloud.ts'
import { setAccountOpen } from '../../lib/store/index.ts'
import { IconUser } from '../Icons.tsx'
import { AccountAvatar } from './Avatar.tsx'

type SignedIn = Extract<CloudState, { state: 'signed_in' }>

/** 侧栏底部的账号入口：已登录显示头像与邮箱，未登录显示「登录」。未配置云端服务时不出现。 */
export function AccountEntry() {
  const signed = () => {
    const s = cloudState()
    return s?.state === 'signed_in' ? (s as SignedIn) : null
  }
  return (
    <Show when={cloudState() && cloudState()?.state !== 'unavailable'}>
      <li>
        <button class="nav-item account-entry" type="button" onClick={() => setAccountOpen(true)}>
          <Show when={signed()} fallback={<IconUser size={15} />}>
            {(s) => <AccountAvatar email={s().email} avatar={s().avatar} small />}
          </Show>
          <span class="account-entry-name">{signed()?.email ?? '登录'}</span>
        </button>
      </li>
    </Show>
  )
}
