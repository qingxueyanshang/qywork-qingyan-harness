/**
 * CodeMirror 装配。
 *
 * 选 CodeMirror 而不是 Monaco：Monaco 约 5MB 且强依赖 Web Worker，
 * 在 WKWebView（macOS 的 Tauri）里 worker 路径和 CSP 都要额外处理；
 * CodeMirror 6 约 200KB、按语言按需加载、无 worker，行为在三个平台一致。
 *
 * 语言包全部动态导入：一次只会用到一两种，全量打进首屏没有道理。
 */

import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, highlightActiveLine, lineNumbers } from '@codemirror/view'

/** 扩展名 → 语言包加载器。找不到就用无高亮的纯文本，不报错。 */
const LOADERS: Record<string, () => Promise<Extension>> = {
  ts: async () => (await import('@codemirror/lang-javascript')).javascript({ typescript: true }),
  tsx: async () =>
    (await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: true }),
  js: async () => (await import('@codemirror/lang-javascript')).javascript(),
  jsx: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true }),
  mjs: async () => (await import('@codemirror/lang-javascript')).javascript(),
  cjs: async () => (await import('@codemirror/lang-javascript')).javascript(),
  json: async () => (await import('@codemirror/lang-json')).json(),
  py: async () => (await import('@codemirror/lang-python')).python(),
  rs: async () => (await import('@codemirror/lang-rust')).rust(),
  html: async () => (await import('@codemirror/lang-html')).html(),
  htm: async () => (await import('@codemirror/lang-html')).html(),
  vue: async () => (await import('@codemirror/lang-html')).html(),
  css: async () => (await import('@codemirror/lang-css')).css(),
  scss: async () => (await import('@codemirror/lang-css')).css(),
  md: async () => (await import('@codemirror/lang-markdown')).markdown(),
  mdx: async () => (await import('@codemirror/lang-markdown')).markdown(),
}

export async function languageFor(path: string): Promise<Extension[]> {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const load = LOADERS[ext]
  if (!load) return []
  try {
    return [await load()]
  } catch {
    // 语言包加载失败只影响高亮，不该让预览整体打不开。
    return []
  }
}

/**
 * 主题。
 *
 * 全部颜色走 CSS 变量，不写死——这样编辑器跟着应用的亮/暗切换走，
 * 不需要维护两份主题，也不会出现「界面暗了但代码区还是白的」。
 */
export const theme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: 'var(--fs-sm)',
    backgroundColor: 'var(--bg-app)',
    color: 'var(--text-primary)',
  },
  '.cm-content': { fontFamily: 'var(--font-mono)', padding: 'var(--s-3) 0' },
  '.cm-gutters': {
    backgroundColor: 'var(--bg-app)',
    color: 'var(--text-tertiary)',
    border: 'none',
  },
  '.cm-activeLine': { backgroundColor: 'var(--bg-hover)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-secondary)' },
  '.cm-scroller': { lineHeight: '1.6' },
  '&.cm-focused': { outline: 'none' },
  '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--accent-soft)' },
})

export async function createReadonlyEditor(
  parent: HTMLElement,
  doc: string,
  path: string,
): Promise<EditorView> {
  const lang = await languageFor(path)
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        // 只读预览：不给编辑能力，避免用户以为改了能存。
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.lineWrapping,
        theme,
        ...lang,
      ],
    }),
  })
}
