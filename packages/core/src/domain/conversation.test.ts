/**
 * 会话标题与附件分类口径。覆盖 `domain/model.ts` 的对应纯函数。
 *
 * 标题函数是全项目**唯一**产生会话标题的位置（`runtime/session.ts` 在第一条用户消息
 * 落库之后调用它）。在此处而不是在 session 上测试，是因为 session 路径需要实际运行一轮才能到达，
 * 而这条纯文本规则本身需要能够单独验证。
 */

import { describe, expect, test } from 'bun:test'
import { attachmentTypeOf, deriveConversationTitle, mimeOf } from './model.ts'

describe('从第一句话提取标题', () => {
  test('短句原样保留', () => {
    expect(deriveConversationTitle('帮我把侧栏的时间显示出来')).toBe('帮我把侧栏的时间显示出来')
  })

  /* 粘贴整段需求时，第二行之后是细节；标题只需要诉求本身。 */
  test('只取首行', () => {
    expect(deriveConversationTitle('修一下登录\n1. 先看接口\n2. 再看前端')).toBe('修一下登录')
  })

  /* 输入中的缩进和连续空格会在侧栏中显示为无意义的空白。 */
  test('连续空白合并为一个空格，去除首尾空白', () => {
    expect(deriveConversationTitle('  修   一下    登录  ')).toBe('修 一下 登录')
  })

  test('超长截断并补省略号', () => {
    const title = deriveConversationTitle('一'.repeat(50))
    expect(title).toBe(`${'一'.repeat(30)}…`)
  })

  /* 代理对被 slice 从中间截断会留下半个字符，渲染为无法显示的方块。 */
  test('按字符截断，不把 emoji 拆成两半', () => {
    const title = deriveConversationTitle('🙂'.repeat(40))
    expect(title).toBe(`${'🙂'.repeat(30)}…`)
    expect(title.includes('\ud83d')).toBe(true)
    expect([...title].length).toBe(31)
  })

  /*
   * 正文为空（只发送了附件）时返回空串，**不生成虚假标题**。
   * 空串由界面显示为「新对话」：该会话确实还没有可读的内容。
   */
  test('正文为空时返回空串', () => {
    expect(deriveConversationTitle('')).toBe('')
    expect(deriveConversationTitle('   \n  ')).toBe('')
  })
})

describe('附件分类', () => {
  test('视频按扩展名进入视频附件并得到正确 MIME', () => {
    expect(attachmentTypeOf('clip.mp4')).toBe('video')
    expect(attachmentTypeOf('clip.webm')).toBe('video')
    expect(attachmentTypeOf('clip.txt')).toBe('file')
    expect(mimeOf('clip.mp4')).toBe('video/mp4')
  })
})
