"""公式校准：逐个公式裁出公式盒，比较 WPS 页面图与本方截图的 SSIM（算法同 score.py）。

输入为 math-calibrate.ts 写出的 crops.json：[{doc, index, line, truth, candidate, box: [x0, y0, x1, y1]}]，坐标为像素，
右下不含。另报告两图在盒内的墨迹外接框（灰度低于 160 的像素）之差，单位为像素。

用法：python math_score.py <crops.json> <输出 json>
"""

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import score  # noqa: E402

INK = 160


def ink_box(a: np.ndarray):
    ys, xs = np.nonzero(a < INK)
    if len(xs) == 0:
        return None
    return [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]


def main():
    crops = json.loads(Path(sys.argv[1]).read_text("utf-8"))
    images = {}

    def load(path):
        if path not in images:
            with Image.open(path) as im:
                images[path] = score.gray(im)
        return images[path]

    out = []
    for c in crops:
        t, k = load(c["truth"]), load(c["candidate"])
        x0, y0, x1, y1 = c["box"]
        h, w = t.shape
        # 不足 SSIM 窗口（11 像素）的一边向两侧补足；补足部分在本方截图中保留了 WPS 页面图，两图相同。
        for lo, hi, axis in ((0, 2, 0), (1, 3, 1)):
            box = [x0, y0, x1, y1]
            short = 2 * score.RADIUS + 1 - (box[hi] - box[lo])
            if short > 0:
                box[lo] -= (short + 1) // 2
                box[hi] += short // 2
            x0, y0, x1, y1 = box
        x0, y0, x1, y1 = max(0, x0), max(0, y0), min(w, x1), min(h, y1)
        if x1 - x0 < 2 or y1 - y0 < 2:
            continue
        a, b = t[y0:y1, x0:x1], k[y0:y1, x0:x1]
        ta, tb = ink_box(a), ink_box(b)
        delta = [tb[i] - ta[i] for i in range(4)] if ta and tb else None
        out.append({"doc": c["doc"], "index": c["index"], "line": c.get("line", 0), "ssim": round(score.ssim(a, b), 4),
                    "size": [x1 - x0, y1 - y0], "ink_delta": delta})
    Path(sys.argv[2]).write_text(json.dumps(out, ensure_ascii=False, indent=1), "utf-8")
    if out:
        values = [o["ssim"] for o in out]
        print(f"{len(out)} 个公式，SSIM 平均 {sum(values) / len(values):.4f}，最低 {min(values):.4f}")


if __name__ == "__main__":
    main()
