import { Show } from 'solid-js'
import { setSquareOpen, squareAvailable } from '../../lib/store/square.ts'
import { IconGrid } from '../Icons.tsx'

/** 左栏底部的创作广场入口：已登录且云端已开通创作广场时出现。 */
export function SquareEntry() {
  return (
    <Show when={squareAvailable()}>
      <li>
        <button class="nav-item" type="button" onClick={() => setSquareOpen(true)}>
          <IconGrid size={15} />
          创作广场
        </button>
      </li>
    </Show>
  )
}
