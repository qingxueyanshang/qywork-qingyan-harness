/** 桌面宠物窗口的入口（`pet.html`）。只加载令牌、图标动画与宠物窗口自身的样式，不加载主界面的样式与状态。 */

import { render } from 'solid-js/web'
import './styles/tokens.css'
import './styles/icons.css'
import './styles/pet-window.css'
import { PetWindow } from './components/appearance/PetWindow.tsx'

const root = document.getElementById('pet-root')
if (!root) throw new Error('#pet-root 缺失')

render(() => <PetWindow />, root)
