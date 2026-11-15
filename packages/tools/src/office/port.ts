import { definePort } from '@qywork/agent'

/**
 * Office 工具的执行程序：Python 解释器与 worker 入口的位置，以及本机各格式的办公软件能力。
 *
 * 宿主在进程启动时探测一次并缓存，按轮注入；工具据此启动 worker，不自行查找解释器。
 * 没有可用的 Python 与文档库，或用户关闭了「Office 文档」时不注入，Office 工具不注册。
 * `apps` 中某个格式不可用时，该格式仍可读取与制作，仅重算、目录回填与渲染报告不可用。
 */
export interface OfficePort {
  /** Python 解释器的绝对路径。 */
  python: string
  /** worker 入口 `worker.py` 的绝对路径。 */
  worker: string
  apps: Record<'docx' | 'xlsx' | 'pptx', { available: boolean; reason: string }>
  /** 视频解码库 av 是否已安装。未安装时 `capture_canvas_frame` 不注册。 */
  videoDecoder: boolean
  /** 开关当前是否开启。每次调用前实时判定：运行中关闭后，后续调用被拒绝，已开始的调用正常结束。 */
  enabled(): boolean
}

export const OfficePort = definePort<OfficePort>('office')
