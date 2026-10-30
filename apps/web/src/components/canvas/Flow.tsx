/**
 * 生成中连线的流动虚线，由 WebGL 绘制在连线层之上、节点层之下。
 *
 * 不要改回 SVG 的 `stroke-dashoffset`：抗锯齿的虚线曲线由 GPU 进程逐图块光栅化，每次推进都重画整层连线中被经过的图块。
 * 2026-10-30 在桌面外壳中实测（2560×1440、180Hz、缩放 32%、12 张视频卡生成、138 条流动连线）：GPU 进程约 103% 单核，
 * 画布每秒 9 帧；推进停止时约 0.3%。此处每次推进只更新一个 uniform，顶点只在几何变化时重建，
 * 连线层的 SVG 在生成期间不发生修改。
 *
 * 外观与原写法相同：线宽 1.5、虚线 4 4、流动位移都按画布单位计，随缩放变粗变细。连线层的缩放是 `<svg>` 元素上的
 * CSS 变换，`vector-effect: non-scaling-stroke` 只抵消 SVG 内部的变换，不抵消它（缩放 32% 时屏幕上线宽约 0.5 像素）。
 * 渐变沿两端连线方向（`gradientUnits="userSpaceOnUse"`）；每 0.8 秒前进一个周期，每秒推进 24 次。
 */

import { createEffect, createMemo, onCleanup, onMount } from 'solid-js'

/** 渐变色标：SVG 中选中节点的连线（`linearGradient`）与此处的流动虚线共用。 */
export const FLOW_STOPS: readonly (readonly [number, string])[] = [
  [0, '#ddd6fe'],
  [0.3, '#a78bfa'],
  [0.62, '#7c3aed'],
  [1, '#5b21b6'],
]
/** 每 0.8 秒前进一个虚线周期（`4 4`），每秒推进 24 次，每次位移约 0.4 像素。 */
const FLOW_PERIOD = 8
const FLOW_CYCLE_MS = 800
const FLOW_TICK_MS = 1000 / 24
/** 线宽的一半（画布单位）与抗锯齿余量（屏幕像素）。 */
const HALF_WIDTH = 0.75
const FRINGE = 1
/** 曲线采样的目标段长（屏幕像素）：段长越短，折线与曲线的偏差越小。 */
const SEGMENT_PX = 4
const MAX_SEGMENTS = 1024
/** 每个顶点：画布坐标 x、y，单位法线 nx、ny，所在一侧 ±1，起点到此的弧长（画布单位），渐变参数。 */
const STRIDE = 7

export interface FlowEdge {
  x1: number
  y1: number
  x2: number
  y2: number
}

/** 连线的三次曲线控制点：两个控制点分别从两端水平偏移 dx。SVG 路径与流动虚线都由它得出。 */
export function curveOf(x1: number, y1: number, x2: number, y2: number): number[] {
  const dx = Math.max(40, (x2 - x1) / 2)
  return [x1, y1, x1 + dx, y1, x2 - dx, y2, x2, y2]
}

export function pathOf(c: number[]): string {
  return `M${c[0]} ${c[1]} C${c[2]} ${c[3]} ${c[4]} ${c[5]} ${c[6]} ${c[7]}`
}

export interface FlowMesh {
  vertices: Float32Array
  indices: Uint32Array
}

/**
 * 沿每条连线的曲线采样，生成两侧各一行顶点的三角形带（以索引三角形表示）。
 * 段数按缩放后的屏幕长度取：缩放改变时须重建，平移不必重建。
 */
export function flowMesh(edges: readonly FlowEdge[], z: number): FlowMesh {
  const plans = edges.map((e) => {
    const c = curveOf(e.x1, e.y1, e.x2, e.y2)
    let hull = 0
    for (let i = 0; i < 6; i += 2) hull += Math.hypot(c[i + 2]! - c[i]!, c[i + 3]! - c[i + 1]!)
    const n = Math.min(MAX_SEGMENTS, Math.max(8, Math.ceil((hull * z) / SEGMENT_PX)))
    return { e, c, n }
  })
  const points = plans.reduce((sum, p) => sum + p.n + 1, 0)
  const vertices = new Float32Array(points * 2 * STRIDE)
  const indices = new Uint32Array(plans.reduce((sum, p) => sum + p.n * 6, 0))
  let v = 0
  let k = 0
  for (const { e, c, n } of plans) {
    const base = v / STRIDE
    const ax = e.x2 - e.x1
    const ay = e.y2 - e.y1
    const span = ax * ax + ay * ay
    let s = 0
    let px = c[0]!
    let py = c[1]!
    for (let i = 0; i <= n; i++) {
      const t = i / n
      const u = 1 - t
      const x =
        u * u * u * c[0]! + 3 * u * u * t * c[2]! + 3 * u * t * t * c[4]! + t * t * t * c[6]!
      const y =
        u * u * u * c[1]! + 3 * u * u * t * c[3]! + 3 * u * t * t * c[5]! + t * t * t * c[7]!
      let tx = 3 * (u * u * (c[2]! - c[0]!) + 2 * u * t * (c[4]! - c[2]!) + t * t * (c[6]! - c[4]!))
      let ty = 3 * (u * u * (c[3]! - c[1]!) + 2 * u * t * (c[5]! - c[3]!) + t * t * (c[7]! - c[5]!))
      const len = Math.hypot(tx, ty)
      if (len > 0) {
        tx /= len
        ty /= len
      } else {
        tx = 1
        ty = 0
      }
      s += Math.hypot(x - px, y - py)
      px = x
      py = y
      const g = span > 0 ? ((x - e.x1) * ax + (y - e.y1) * ay) / span : 0
      // 拖动节点时每次移动都重建：逐项写入，不为每个顶点分配临时数组。
      for (let side = -1; side <= 1; side += 2) {
        vertices[v] = x
        vertices[v + 1] = y
        vertices[v + 2] = -ty
        vertices[v + 3] = tx
        vertices[v + 4] = side
        vertices[v + 5] = s
        vertices[v + 6] = g
        v += STRIDE
      }
    }
    for (let i = 0; i < n; i++) {
      const a = base + 2 * i
      indices[k] = a
      indices[k + 1] = a + 1
      indices[k + 2] = a + 2
      indices[k + 3] = a + 1
      indices[k + 4] = a + 3
      indices[k + 5] = a + 2
      k += 6
    }
  }
  return { vertices, indices }
}

const VERTEX = `#version 300 es
in vec2 aPos;
in vec2 aNormal;
in float aSide;
in float aS;
in float aT;
uniform vec2 uPan;
uniform float uZ;
uniform vec2 uView;
uniform float uExtent;
out float vAcross;
out float vS;
out float vT;
void main() {
  vec2 css = aPos * uZ + uPan + aNormal * aSide * uExtent;
  vec2 clip = css / uView * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  vAcross = aSide * uExtent;
  vS = aS;
  vT = aT;
}`

const FRAGMENT = `#version 300 es
precision highp float;
in float vAcross;
in float vS;
in float vT;
uniform float uFlow;
uniform float uZ;
uniform float uDpr;
uniform float uHalf;
uniform vec3 uColor[4];
uniform float uStop[4];
out vec4 outColor;
vec3 ramp(float t) {
  if (t <= uStop[1]) return mix(uColor[0], uColor[1], (t - uStop[0]) / (uStop[1] - uStop[0]));
  if (t <= uStop[2]) return mix(uColor[1], uColor[2], (t - uStop[1]) / (uStop[2] - uStop[1]));
  return mix(uColor[2], uColor[3], (t - uStop[2]) / (uStop[3] - uStop[2]));
}
void main() {
  float across = clamp((uHalf - abs(vAcross)) * uDpr + 0.5, 0.0, 1.0);
  float ph = mod(vS + uFlow, 8.0);
  float edge = (ph < 4.0 ? min(ph, 4.0 - ph) : -min(ph - 4.0, 8.0 - ph)) * uZ;
  float dash = clamp(edge * uDpr + 0.5, 0.0, 1.0);
  float a = across * dash;
  outColor = vec4(ramp(clamp(vT, 0.0, 1.0)) * a, a);
}`

interface Renderer {
  setMesh(mesh: FlowMesh): void
  draw(
    view: { px: number; py: number; z: number; width: number; height: number; dpr: number },
    flow: number,
  ): void
  dispose(): void
}

function rgb(hex: string): number[] {
  const n = Number.parseInt(hex.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/** 无法取得 WebGL2 上下文或着色器编译失败时返回 null，由调用方改用静止的虚线。 */
function createRenderer(canvas: HTMLCanvasElement): Renderer | null {
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, antialias: false })
  if (!gl) return null
  const shader = (type: number, source: string) => {
    const s = gl.createShader(type)
    if (!s) return null
    gl.shaderSource(s, source)
    gl.compileShader(s)
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null
  }
  const vs = shader(gl.VERTEX_SHADER, VERTEX)
  const fs = shader(gl.FRAGMENT_SHADER, FRAGMENT)
  const program = gl.createProgram()
  if (!vs || !fs || !program) return null
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null
  gl.useProgram(program)
  const vao = gl.createVertexArray()
  const vbo = gl.createBuffer()
  const ibo = gl.createBuffer()
  gl.bindVertexArray(vao)
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo)
  const attrs: [string, number, number][] = [
    ['aPos', 2, 0],
    ['aNormal', 2, 2],
    ['aSide', 1, 4],
    ['aS', 1, 5],
    ['aT', 1, 6],
  ]
  for (const [name, size, offset] of attrs) {
    const at = gl.getAttribLocation(program, name)
    gl.enableVertexAttribArray(at)
    gl.vertexAttribPointer(at, size, gl.FLOAT, false, STRIDE * 4, offset * 4)
  }
  const u = (name: string) => gl.getUniformLocation(program, name)
  const uPan = u('uPan')
  const uZ = u('uZ')
  const uView = u('uView')
  const uExtent = u('uExtent')
  const uFlow = u('uFlow')
  const uDpr = u('uDpr')
  const uHalf = u('uHalf')
  gl.uniform3fv(
    u('uColor'),
    FLOW_STOPS.flatMap(([, color]) => rgb(color)),
  )
  gl.uniform1fv(
    u('uStop'),
    FLOW_STOPS.map(([offset]) => offset),
  )
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  let count = 0
  return {
    setMesh(mesh) {
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
      gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW)
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo)
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW)
      count = mesh.indices.length
    },
    draw(view, flow) {
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      if (!count || !view.width || !view.height) return
      gl.uniform2f(uPan, view.px, view.py)
      gl.uniform1f(uZ, view.z)
      gl.uniform2f(uView, view.width, view.height)
      gl.uniform1f(uHalf, HALF_WIDTH * view.z)
      gl.uniform1f(uExtent, HALF_WIDTH * view.z + FRINGE / view.dpr)
      gl.uniform1f(uFlow, flow)
      gl.uniform1f(uDpr, view.dpr)
      gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_INT, 0)
    },
    dispose() {
      gl.deleteBuffer(vbo)
      gl.deleteBuffer(ibo)
      gl.deleteVertexArray(vao)
      gl.deleteProgram(program)
      gl.deleteShader(vs)
      gl.deleteShader(fs)
    },
  }
}

/**
 * 流动虚线层：覆盖整个画布区，不接收指针。只在有生成中的连线时取得 WebGL 上下文并按 24 次每秒推进；
 * `onReady` 报告能否绘制，不能绘制时连线层改为显示静止的渐变虚线。
 */
export function FlowLayer(p: {
  edges: FlowEdge[]
  px: number
  py: number
  z: number
  onReady: (ok: boolean) => void
}) {
  let canvas!: HTMLCanvasElement
  let renderer: Renderer | null | undefined
  let flow = 0
  let frame = 0
  let size = { width: 0, height: 0, dpr: 1 }
  let key = ''
  const draw = () => {
    frame = 0
    renderer?.draw({ px: p.px, py: p.py, z: p.z, ...size }, flow)
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(draw)
  }
  const resize = () => {
    const dpr = window.devicePixelRatio || 1
    size = { width: canvas.clientWidth, height: canvas.clientHeight, dpr }
    canvas.width = Math.round(size.width * dpr)
    canvas.height = Math.round(size.height * dpr)
    schedule()
  }
  onMount(() => {
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    onCleanup(() => observer.disconnect())
    resize()
  })
  // 连线数组随选中、状态等任何变化重新生成；只有几何或缩放变化时才重建顶点。
  createEffect(() => {
    const edges = p.edges
    if (edges.length && renderer === undefined) {
      renderer = createRenderer(canvas)
      p.onReady(renderer !== null)
    }
    if (!renderer) return
    const next = edges.length
      ? `${p.z}|${edges.map((e) => `${e.x1},${e.y1},${e.x2},${e.y2}`).join(';')}`
      : ''
    if (next !== key) {
      key = next
      renderer.setMesh(edges.length ? flowMesh(edges, p.z) : flowMesh([], p.z))
    }
    schedule()
  })
  createEffect(() => {
    void [p.px, p.py, p.z]
    schedule()
  })
  // 只在开始与全部结束时启动或停止推进：连线数组重新生成不重置流动的相位。
  const active = createMemo(() => p.edges.length > 0)
  createEffect(() => {
    if (!active() || !renderer) return
    const start = performance.now()
    const timer = setInterval(() => {
      flow = -(((performance.now() - start) / FLOW_CYCLE_MS) * FLOW_PERIOD) % FLOW_PERIOD
      schedule()
    }, FLOW_TICK_MS)
    onCleanup(() => clearInterval(timer))
  })
  onCleanup(() => {
    if (frame) cancelAnimationFrame(frame)
    renderer?.dispose()
  })
  return <canvas class="canvas-flow" ref={canvas} />
}
