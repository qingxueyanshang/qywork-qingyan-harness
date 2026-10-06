import { render } from 'solid-js/web'
import './styles/tokens.css'
import './styles/base.css'
import './styles/app.css'
import { App } from './App.tsx'
import { initTheme } from './lib/store/index.ts'

// 先应用主题再 render：顺序相反时，若系统为浅色而用户选择深色，首帧会以浅色闪现。
initTheme()

const root = document.getElementById('root')
if (!root) throw new Error('#root 缺失')

render(() => <App />, root)
