/**
 * 缩放比例与加减按钮。文件预览的工具栏与内置浏览器的地址栏共用。
 *
 * `ratio` 为 0 表示比例尚不可知，显示「—」且两个按钮禁用；到达 `min` 或 `max` 时对应按钮禁用。
 */
export default function ZoomControl(props: {
  ratio: number
  min: number
  max: number
  onStep: (direction: 1 | -1) => void
}) {
  /** 浮点误差内视为已到端点。 */
  const at = (limit: number) => Math.abs(props.ratio - limit) < 1e-3
  return (
    <span class="zoom-control">
      <button
        type="button"
        aria-label="缩小"
        disabled={!props.ratio || props.ratio < props.min || at(props.min)}
        onClick={() => props.onStep(-1)}
      >
        −
      </button>
      <output aria-label="缩放比例">
        {props.ratio ? `${Math.round(props.ratio * 100)}%` : '—'}
      </output>
      <button
        type="button"
        aria-label="放大"
        disabled={!props.ratio || props.ratio > props.max || at(props.max)}
        onClick={() => props.onStep(1)}
      >
        +
      </button>
    </span>
  )
}
