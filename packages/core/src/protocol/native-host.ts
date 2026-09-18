/**
 * 两条原生宿主连接共用的凭据。
 *
 * `/native/browser` 与 `/native/desktop` 由同一个桌面外壳进程发起，同一次启动只有一个
 * 随机值。**区分宿主种类的是 URL 路径，不是客户端自报的字段**，共用凭据不会让一条连接
 * 串到另一条的帧处理上。
 */

/**
 * 宿主凭据所在的请求头。
 *
 * 不放查询串：URL 会进访问日志与错误信息，而这个值等同于「可以注册宿主」。
 */
export const NATIVE_HOST_KEY_HEADER = 'x-qywork-host-key'
