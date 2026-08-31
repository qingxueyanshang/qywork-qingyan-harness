/**
 * 会话标题与附件分类口径。覆盖 `domain/model.ts` 的对应纯函数。
 *
 * 它是全项目**唯一**一处产生会话标题的地方（`runtime/session.ts` 在第一条用户消息
 * 落库之后调它）。锁在这里而不是在 session 上，是因为那条路要真跑一轮才走得到，
 * 而这一份纯文本规则本身要能单独验。
 */

import { describe, expect, test } from 'bun:test'
import { attachmentTypeOf, deriveConversationTitle, mimeOf } from './model.ts'

describe('从第一句话取标题', () => {
  test('短句原样留下', () => {
    expect(deriveConversationTitle('帮我把侧栏的时间显示出来')).toBe('帮我把侧栏的时间显示出来')
  })

  /* 粘贴一整段需求时，第二行往后是细节；标题要的是那句诉求本身。 */
  test('只取首行', () => {
    expect(deriveConversationTitle('修一下登录\n1. 先看接口\n2. 再看前端')).toBe('修一下登录')
  })

  /* 输入里的缩进和连续空格会在侧栏里变成一段无意义的空白。 */
  test('连续空白压成一个空格，首尾空白去掉', () => {
    expect(deriveConversationTitle('  修   一下    登录  ')).toBe('修 一下 登录')
  })

  test('超长截断并补省略号', () => {
    const title = deriveConversationTitle('一'.repeat(50))
    expect(title).toBe(`${'一'.repeat(30)}…`)
  })

  /* 代理对被 slice 从中间劈开会留下半个字符——那是个渲染不出来的方块。 */
  test('按字符截，不把 emoji 劈成两半', () => {
    const title = deriveConversationTitle('🙂'.repeat(40))
    expect(title).toBe(`${'🙂'.repeat(30)}…`)
    expect(title.includes('\ud83d')).toBe(true)
    expect([...title].length).toBe(31)
  })

  /*
   * 正文为空（只发了附件）时回空串，**不造一个假标题**。
   * 空串由界面兜底成「新对话」——这条会话确实还没有可读的内容。
   */
  test('空正文回空串', () => {
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
