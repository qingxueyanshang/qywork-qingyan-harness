import { render } from 'solid-js/web'
import './styles/tokens.css'
import './styles/base.css'
import './styles/app.css'
import { App } from './App.tsx'

const root = document.getElementById('root')
if (!root) throw new Error('#root 缺失')

render(() => <App />, root)
