/** 源码重载与应用更新共用服务端的空闲占位，取得占位后才允许结束旧进程。 */
export async function requestUpdateClaim(port: number, key: string, action: 'claim' | 'cancel') {
  const response = await fetch(`http://127.0.0.1:${port}/internal/app-update`, {
    method: 'POST',
    headers: { 'x-qywork-update-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) throw new Error('无法确认任务是否空闲')
  const result = (await response.json()) as { claimed?: unknown; busy?: unknown }
  if (typeof result.claimed !== 'boolean') throw new Error('任务空闲回执无效')
  return { claimed: result.claimed, busy: Number(result.busy) || 0 }
}
