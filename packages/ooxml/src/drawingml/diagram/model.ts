/**
 * SmartArt（DrawingML 图示）的模型：四个部件的读取结果与按数据实例化后的布局树。纯数据，可经 `postMessage` 传递。
 *
 * - 显示依据（WPS 实测）：按数据部件、布局定义、颜色定义与样式定义排版，不读取图形部件（`diagramDrawing`）；
 *   布局定义取文件中的内容，不按 `uniqueId` 取内置定义。
 * - 长度为 EMU，字号为磅。约束与规则的数值保持文件中的单位，换算见 `layout.ts`。
 */

import type { ColorSpec } from '../color.ts'
import type { Effect, Line, ShapeFill } from '../fill.ts'
import type { Geometry } from '../geometry/model.ts'
import type { ShapeProps, StyleRefs } from '../shape/read.ts'
import type { TextBody } from '../text/model.ts'
import type { RawTextBody } from '../text/read.ts'

export type PointType = 'doc' | 'node' | 'asst' | 'parTrans' | 'sibTrans' | 'pres'

export interface DataPoint {
  readonly id: string
  readonly type: PointType
  /** `dgm:t`；没有时为 `null`。 */
  readonly text: RawTextBody | null
  /** `dgm:spPr`：用户对该点所在形状设置的填充、线条与效果。 */
  readonly props: ShapeProps
  /** 以下为 `prSet` 的属性：pres 点所属的布局节点名、所表示的数据点与样式标签。 */
  readonly presName: string | null
  readonly presAssoc: string | null
  readonly styleLabel: string | null
  /** `presLayoutVars` 中的变量：名称 → `val`，未写 `val` 时为空串。 */
  readonly vars: Readonly<Record<string, string>>
  /** `prSet` 中以 `cust` 开头的属性：名称 → 数值。 */
  readonly custom: Readonly<Record<string, number>>
}

export interface DataConnection {
  /** `parOf`（缺省）、`presOf`、`presParOf`。 */
  readonly type: string
  readonly src: string
  readonly dest: string
  readonly srcOrd: number
  readonly parTrans: string | null
  readonly sibTrans: string | null
}

export interface DataModel {
  readonly points: readonly DataPoint[]
  readonly connections: readonly DataConnection[]
  /** `dgm:bg`、`dgm:whole` 有内容（整体背景、整体线条）。 */
  readonly decorated: boolean
}

/** `forEach`、`presOf` 与 `if` 共有的遍历属性；`axis`、`ptType` 为空格分隔的列表。 */
export interface Iteration {
  readonly axis: string
  readonly ptType: string
  readonly start: number
  /** 0 为不限。 */
  readonly count: number
  readonly step: number
  readonly hideLastTrans: boolean
}

export interface Condition extends Iteration {
  readonly func: string
  readonly arg: string
  readonly op: string
  readonly val: string
}

export interface Constraint {
  readonly type: string
  readonly for: string
  readonly forName: string
  readonly ptType: string
  readonly refType: string
  readonly refFor: string
  readonly refForName: string
  readonly refPtType: string
  readonly op: string
  /** 未写出时为 `null`。 */
  readonly val: number | null
  readonly fact: number
}

/** `val`、`fact`、`max` 可为 `NaN`（不限）或 `Infinity`。 */
export interface Rule {
  readonly type: string
  readonly for: string
  readonly forName: string
  readonly ptType: string
  readonly val: number
  readonly fact: number
  readonly max: number
}

export interface ShapeSpec {
  /** 预设几何名、`conn`，或空串（不绘制几何）。 */
  readonly type: string
  readonly rotation: number
  readonly hideGeometry: boolean
  /** `adj`：`idx` 从 1 起，`val` 为文件中的值。 */
  readonly adjust: readonly { readonly idx: number; readonly val: number }[]
}

export type LayoutAtom =
  | {
      readonly kind: 'layoutNode'
      readonly name: string
      readonly styleLabel: string | null
      readonly children: readonly LayoutAtom[]
    }
  | {
      readonly kind: 'alg'
      readonly type: string
      readonly params: Readonly<Record<string, string>>
    }
  | { readonly kind: 'shape'; readonly shape: ShapeSpec }
  | { readonly kind: 'presOf'; readonly iteration: Iteration }
  | { readonly kind: 'constraints'; readonly list: readonly Constraint[] }
  | { readonly kind: 'rules'; readonly list: readonly Rule[] }
  | { readonly kind: 'vars'; readonly vars: Readonly<Record<string, string>> }
  | {
      readonly kind: 'choose'
      /** `if` 依次在前，`else` 的条件为 `null`。 */
      readonly branches: readonly {
        readonly condition: Condition | null
        readonly children: readonly LayoutAtom[]
      }[]
    }
  | {
      readonly kind: 'forEach'
      readonly iteration: Iteration
      /** `ref` 属性（引用另一个 `forEach`）。 */
      readonly ref: string | null
      readonly children: readonly LayoutAtom[]
    }
  /** 未识别的元素：使整个图示不绘制。 */
  | { readonly kind: 'unknown'; readonly name: string }

export interface ColorList {
  /** `repeat`（缺省）、`cycle`、`span`。 */
  readonly method: string
  readonly colors: readonly ColorSpec[]
}

export interface ColorLabel {
  readonly fill: ColorList
  readonly line: ColorList
  readonly effect: ColorList
  readonly textFill: ColorList
}

export interface RawDiagram {
  readonly data: DataModel
  /** 布局定义的根布局节点；布局部件缺失或没有布局节点时为 `null`（WPS 不显示该图示）。 */
  readonly layout: LayoutAtom | null
  readonly colors: Readonly<Record<string, ColorLabel>>
  readonly styles: Readonly<Record<string, StyleRefs>>
}

/** 布局算法；`params` 为 `alg/param` 的 `type` → `val`。 */
export interface Algorithm {
  readonly type: 'lin' | 'composite' | 'tx' | 'sp' | 'conn' | 'none'
  readonly params: Readonly<Record<string, string>>
}

/** 布局节点实例的形状：几何、已求值的填充线条效果；`hideGeom` 时填充与线条为空。 */
export interface DiagramShape {
  readonly geometry: Geometry
  readonly rotation: number
  readonly fill: ShapeFill
  readonly line: Line | null
  readonly effects: readonly Effect[]
}

export interface DiagramNode {
  readonly name: string
  /** 实例所对应数据点的种类，供约束与规则的 `ptType` 匹配。 */
  readonly pointType: PointType
  readonly algorithm: Algorithm
  /** `conn` 算法的形状由算法决定，此处为 `null`；没有几何（空 `type`）时同样为 `null`。 */
  readonly shape: DiagramShape | null
  /** `conn` 形状的填充、线条与效果（几何由算法决定）。 */
  readonly connector: Omit<DiagramShape, 'geometry' | 'rotation'> | null
  /** `presOf` 所选数据点的文字（字号与边距在排版时确定）；没有文字时为 `null`。 */
  readonly text: TextBody | null
  readonly constraints: readonly Constraint[]
  readonly rules: readonly Rule[]
  /** `custLinFactNeighborX`、`custLinFactNeighborY`（比例，100000 为 1）。 */
  readonly neighborFactor: { readonly x: number; readonly y: number }
  readonly children: readonly DiagramNode[]
}

export interface Diagram {
  readonly root: DiagramNode
}
