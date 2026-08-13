import { render } from 'solid-js/web'
import './styles/tokens.css'
import './styles/base.css'
import './styles/app.css'
import { App } from './App.tsx'
import { initTheme } from './lib/store/index.ts'

// 先落主题再 render：反过来的话，系统是亮色而用户选了深色时会先闪一帧白的。
initTheme()

const root = document.getElementById('root')
if (!root) throw new Error('#root 缺失')

render(() => <App />, root)
