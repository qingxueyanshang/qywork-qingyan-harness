"""逐页 SSIM 打分与报告。

SSIM：灰度（Pillow 的 L 模式，ITU-R 601-2 亮度）；高斯窗口 σ=1.5、半径 5；K1=0.01、K2=0.03、L=255；
只在窗口完整落入图像的区域内计算，取整幅 SSIM 图的均值。只依赖 numpy。
尺寸对齐：候选图按真值图尺寸用 Lanczos 重采样；宽高比偏差另行记录，不在打分前裁切或补边，
比例错误因此直接计入分数。带透明通道的候选图先叠加到白底上。
页数不一致：真值有而候选缺失的页记 0 分，候选多出的页同样记 0 分。
按格式筛选：只计入真值清单中 `format` 属于给定格式的文档，其余文档不计分、不列入报告。
"""

import json
import time
from pathlib import Path

import numpy as np
from PIL import Image

SIGMA, RADIUS = 1.5, 5
C1, C2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2


def _kernel():
    x = np.arange(-RADIUS, RADIUS + 1, dtype=np.float64)
    k = np.exp(-(x ** 2) / (2 * SIGMA ** 2))
    return k / k.sum()


def _filter(a, k):
    """可分离高斯滤波，valid 模式：输出比输入每边少 RADIUS 个像素。"""
    w = len(k)
    rows = sum(k[i] * a[:, i:a.shape[1] - w + 1 + i] for i in range(w))
    return sum(k[i] * rows[i:rows.shape[0] - w + 1 + i, :] for i in range(w))


def ssim_map(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """两张同尺寸灰度图（float64，0–255）的 SSIM 图，每边比输入少 RADIUS 个像素。两边都不得小于窗口。"""
    if a.shape != b.shape:
        raise ValueError(f"尺寸不一致：{a.shape} 与 {b.shape}")
    k = _kernel()
    mu_a, mu_b = _filter(a, k), _filter(b, k)
    saa = _filter(a * a, k) - mu_a ** 2
    sbb = _filter(b * b, k) - mu_b ** 2
    sab = _filter(a * b, k) - mu_a * mu_b
    num = (2 * mu_a * mu_b + C1) * (2 * sab + C2)
    den = (mu_a ** 2 + mu_b ** 2 + C1) * (saa + sbb + C2)
    return num / den


def ssim(a: np.ndarray, b: np.ndarray) -> float:
    """两张同尺寸灰度图（float64，0–255）的平均 SSIM。图像小于窗口时按逐像素相等判定。"""
    if a.shape != b.shape:
        raise ValueError(f"尺寸不一致：{a.shape} 与 {b.shape}")
    if min(a.shape) < 2 * RADIUS + 1:
        return float(np.array_equal(a, b))
    return float(ssim_map(a, b).mean())


def gray(img: Image.Image) -> np.ndarray:
    """转为灰度数组；带透明通道的图先叠加到白底上。"""
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGBA")
        base = Image.new("RGBA", img.size, "white")
        img = Image.alpha_composite(base, img)
    return np.asarray(img.convert("L"), dtype=np.float64)


def ssim_images(truth: Image.Image, cand: Image.Image) -> float:
    if cand.size != truth.size:
        cand = cand.resize(truth.size, Image.LANCZOS)
    return ssim(gray(truth), gray(cand))


def score_page(truth_png: Path, cand_png: Path) -> dict:
    with Image.open(truth_png) as t, Image.open(cand_png) as c:
        t.load()
        c.load()
        aspect = abs((c.width / c.height) / (t.width / t.height) - 1)
        return {"ssim": round(ssim_images(t, c), 4), "truth_size": t.size, "candidate_size": c.size,
                "resized": c.size != t.size, "aspect_delta": round(aspect, 4)}


def _label(page: dict) -> str:
    if "sheet" in page:
        return f"{page['sheet']}（{page['range']}）"
    return f"第 {page['n']} 页"


def run(truth_dir: Path, cand_dir: Path, json_out: Path, md_out: Path, formats=None) -> dict:
    """`formats` 为格式名的集合（如 `{"pptx"}`），`None` 为全部格式。"""
    top = json.loads((truth_dir / "manifest.json").read_text("utf-8"))
    docs, no_truth = [], []
    for entry in top["documents"]:
        if formats is not None and entry.get("format") not in formats:
            continue
        if entry.get("status") != "ok":
            no_truth.append({k: entry.get(k) for k in ("id", "path", "format", "status", "reason", "error")})
            continue
        manifest = json.loads((truth_dir / entry["id"] / "manifest.json").read_text("utf-8"))
        cdir = cand_dir / entry["id"]
        cand_files = sorted(cdir.glob("page-*.png")) if cdir.is_dir() else []
        pages = []
        for p in manifest["pages"]:
            cpng = cdir / p["file"]
            row = {"n": p["n"], "label": _label(p)}
            if cpng.is_file():
                row.update(score_page(truth_dir / entry["id"] / p["file"], cpng))
            else:
                row.update(ssim=0.0, note="候选缺失")
            pages.append(row)
        extra = [f for f in cand_files if f.name not in {p["file"] for p in manifest["pages"]}]
        for f in extra:
            pages.append({"n": None, "label": f.name, "ssim": 0.0, "note": "候选多出的页"})
        scores = [p["ssim"] for p in pages]
        docs.append({"id": entry["id"], "name": Path(manifest["path"]).name, "format": manifest["format"],
                     "truth_pages": len(manifest["pages"]), "candidate_pages": len(cand_files),
                     "mean": round(sum(scores) / len(scores), 4) if scores else 0.0,
                     "min": min(scores) if scores else 0.0, "pages": pages})
    docs.sort(key=lambda d: (d["mean"], d["min"]))
    all_pages = sorted(({"doc": d["id"], "name": d["name"], **p} for d in docs for p in d["pages"]),
                       key=lambda p: p["ssim"])
    total = [p["ssim"] for p in all_pages]
    report = {"generated_at": time.strftime("%Y-%m-%d %H:%M:%S"), "truth": str(truth_dir),
              "candidates": str(cand_dir), "formats": sorted(formats) if formats is not None else None,
              "pages": len(total),
              "mean": round(sum(total) / len(total), 4) if total else 0.0,
              "documents": docs, "lowest_pages": all_pages, "no_truth": no_truth}
    json_out.write_text(json.dumps(report, ensure_ascii=False, indent=2), "utf-8")
    md_out.write_text(_markdown(report), "utf-8")
    return report


def _markdown(r: dict) -> str:
    lines = [f"# 保真对比报告（{r['generated_at']}）", "",
             f"- 真值：`{r['truth']}`", f"- 候选：`{r['candidates']}`",
             f"- 格式：{'、'.join(r['formats']) if r['formats'] else '全部'}",
             f"- 共 {r['pages']} 页，平均 SSIM {r['mean']:.4f}", "",
             "## 文档（按平均分升序）", "",
             "| 文档 | 格式 | 真值页数 | 候选页数 | 平均 | 最低 |", "|---|---|---|---|---|---|"]
    for d in r["documents"]:
        lines.append(f"| {d['name']}（`{d['id']}`） | {d['format']} | {d['truth_pages']} | "
                     f"{d['candidate_pages']} | {d['mean']:.4f} | {d['min']:.4f} |")
    lines += ["", "## 页（按分数升序，前 40 页）", "", "| SSIM | 文档 | 页 | 备注 |", "|---|---|---|---|"]
    for p in r["lowest_pages"][:40]:
        note = p.get("note") or ("已重采样，宽高比偏差 " + f"{p['aspect_delta']:.2%}" if p.get("resized") else "")
        lines.append(f"| {p['ssim']:.4f} | {p['name']} | {p['label']} | {note} |")
    if r["no_truth"]:
        lines += ["", "## 无真值", ""]
        for d in r["no_truth"]:
            lines.append(f"- {Path(d['path']).name}（`{d['id']}`）：{d.get('reason') or d.get('error')}")
    return "\n".join(lines) + "\n"
