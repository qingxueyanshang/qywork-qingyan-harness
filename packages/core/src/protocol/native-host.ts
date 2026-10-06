/**
 * 两个原生宿主连接共用的凭据。
 *
 * `/native/browser` 与 `/native/desktop` 由同一个桌面外壳进程发起，同一次启动只有一个
 * 随机值。区分宿主种类的是 URL 路径，而不是客户端自报的字段，共用凭据不会使一个连接
 * 的帧进入另一个连接的处理逻辑。
 */

/**
 * 宿主凭据所在的请求头。
 *
 * 不放在查询串中：URL 会写入访问日志与错误信息，而该值等同于注册宿主的权限。
 */
export const NATIVE_HOST_KEY_HEADER = 'x-qywork-host-key'
