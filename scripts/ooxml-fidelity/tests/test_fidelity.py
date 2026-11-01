"""覆盖 score.py（SSIM、报告的页数对齐规则与按格式筛选）、fidelity.py 的 score 子命令（--format 参数）
与 emf.py（按图片框回放、超出部分裁去）。

运行：python -m unittest discover -s scripts/ooxml-fidelity/tests
临时文件位于 .tmp/ooxml-fidelity/tests。emf 的用例调用 GDI，只在 Windows 上运行。
"""

import ctypes
import json
import shutil
import subprocess
import sys
import unittest
from ctypes import wintypes
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
ROOT = HERE.parents[2]
TMP = ROOT / ".tmp" / "ooxml-fidelity" / "tests"

import numpy as np  # noqa: E402
import score  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402


def _page(seed: int, size=(200, 280)) -> Image.Image:
    img = Image.new("RGB", size, "white")
    d = ImageDraw.Draw(img)
    rng = np.random.default_rng(seed)
    for _ in range(40):
        x, y = int(rng.integers(0, size[0] - 30)), int(rng.integers(0, size[1] - 10))
        d.rectangle((x, y, x + 25, y + 6), fill="black")
    return img


def _write_truth(base: Path, doc: str, pages: list, fmt: str = "docx"):
    d = base / doc
    d.mkdir(parents=True)
    entries = []
    for n, img in enumerate(pages, 1):
        img.save(d / f"page-{n:04d}.png")
        entries.append({"n": n, "file": f"page-{n:04d}.png"})
    (d / "manifest.json").write_text(json.dumps({"path": f"{doc}.{fmt}", "format": fmt, "pages": entries}), "utf-8")
    return {"id": doc, "path": f"{doc}.{fmt}", "format": fmt, "status": "ok"}


def _mixed_truth(truth: Path, cand: Path):
    """docx 一份两页（候选缺失，记 0 分）、pptx 一份两页（候选与真值相同）、xlsx 一份无真值。"""
    docs = [_write_truth(truth, "docx-a", [_page(1), _page(2)]),
            _write_truth(truth, "pptx-b", [_page(3), _page(4)], "pptx"),
            {"id": "xlsx-c", "path": "c.xlsx", "format": "xlsx", "status": "skipped", "reason": "无真值"}]
    (truth / "manifest.json").write_text(json.dumps({"documents": docs}), "utf-8")
    (cand / "pptx-b").mkdir(parents=True)
    _page(3).save(cand / "pptx-b" / "page-0001.png")
    _page(4).save(cand / "pptx-b" / "page-0002.png")


class ScoreTest(unittest.TestCase):
    def setUp(self):
        shutil.rmtree(TMP, ignore_errors=True)
        TMP.mkdir(parents=True)

    def test_identical_is_one_and_noise_is_lower(self):
        a = _page(1)
        self.assertAlmostEqual(score.ssim_images(a, a), 1.0, places=6)
        self.assertLess(score.ssim_images(a, _page(2)), 0.9)

    def test_missing_and_extra_pages_score_zero(self):
        truth, cand = TMP / "truth", TMP / "cand"
        docs = [_write_truth(truth, "docx-a", [_page(1), _page(2), _page(3)])]
        (truth / "manifest.json").write_text(json.dumps({"documents": docs}), "utf-8")
        (cand / "docx-a").mkdir(parents=True)
        _page(1).save(cand / "docx-a" / "page-0001.png")
        _page(2).resize((400, 560)).save(cand / "docx-a" / "page-0002.png")
        _page(9).save(cand / "docx-a" / "page-0004.png")
        r = score.run(truth, cand, TMP / "r.json", TMP / "r.md")
        pages = {p["label"]: p for p in r["documents"][0]["pages"]}
        self.assertEqual(pages["第 1 页"]["ssim"], 1.0)
        self.assertTrue(pages["第 2 页"]["resized"])
        self.assertGreater(pages["第 2 页"]["ssim"], 0.9)
        self.assertEqual(pages["第 3 页"]["ssim"], 0.0)
        self.assertEqual(pages["page-0004.png"]["ssim"], 0.0)
        self.assertEqual(r["lowest_pages"][0]["ssim"], 0.0)

    def test_document_without_candidate_dir_scores_zero(self):
        truth = TMP / "truth"
        docs = [_write_truth(truth, "docx-b", [_page(4)]),
                {"id": "pptx-c", "path": "c.pptx", "format": "pptx", "status": "skipped", "reason": "无真值"}]
        (truth / "manifest.json").write_text(json.dumps({"documents": docs}), "utf-8")
        r = score.run(truth, TMP / "none", TMP / "r.json", TMP / "r.md")
        self.assertEqual(r["documents"][0]["mean"], 0.0)
        self.assertEqual([d["id"] for d in r["no_truth"]], ["pptx-c"])


    def test_format_filter_scores_only_given_formats(self):
        truth, cand = TMP / "truth", TMP / "cand"
        _mixed_truth(truth, cand)
        everything = score.run(truth, cand, TMP / "all.json", TMP / "all.md")
        self.assertEqual(everything["pages"], 4)
        self.assertEqual(everything["mean"], 0.5)
        self.assertIsNone(everything["formats"])

        r = score.run(truth, cand, TMP / "r.json", TMP / "r.md", {"pptx"})
        self.assertEqual([d["id"] for d in r["documents"]], ["pptx-b"])
        self.assertEqual(r["pages"], 2)
        self.assertEqual(r["mean"], 1.0)
        self.assertEqual(r["no_truth"], [])
        self.assertEqual(r["formats"], ["pptx"])
        self.assertIn("格式：pptx", (TMP / "r.md").read_text("utf-8"))

        r = score.run(truth, cand, TMP / "r.json", TMP / "r.md", {"docx", "xlsx"})
        self.assertEqual([d["id"] for d in r["documents"]], ["docx-a"])
        self.assertEqual(r["mean"], 0.0)
        self.assertEqual([d["id"] for d in r["no_truth"]], ["xlsx-c"])


class ScoreCommandTest(unittest.TestCase):
    """fidelity.py score 的 --format 参数传到打分；不在格式表中的取值由参数解析拒绝。"""

    def setUp(self):
        shutil.rmtree(TMP, ignore_errors=True)
        TMP.mkdir(parents=True)

    def _score(self, *extra):
        script = HERE.parent / "fidelity.py"
        return subprocess.run([sys.executable, str(script), "score", "--truth", str(TMP / "truth"),
                               "--candidates", str(TMP / "cand"), "--name", "tests/cli", *extra],
                              capture_output=True, text=True, encoding="utf-8")

    def test_format_argument(self):
        _mixed_truth(TMP / "truth", TMP / "cand")
        done = self._score("--format", "pptx")
        self.assertEqual(done.returncode, 0, done.stderr)
        report = json.loads((TMP / "cli.json").read_text("utf-8"))
        self.assertEqual((report["pages"], report["mean"], report["formats"]), (2, 1.0, ["pptx"]))

        done = self._score()
        self.assertEqual(done.returncode, 0, done.stderr)
        report = json.loads((TMP / "cli.json").read_text("utf-8"))
        self.assertEqual((report["pages"], report["formats"]), (4, None))

        self.assertNotEqual(self._score("--format", "pdf").returncode, 0)


@unittest.skipUnless(sys.platform == "win32", "GDI 只在 Windows 上可用")
class EmfTest(unittest.TestCase):
    def _emf(self) -> bytes:
        """100×50 mm 的图片框；整框填黑，另在框外右下方再画 20 mm 的黑色方块。"""
        gdi32 = ctypes.windll.gdi32
        vp = ctypes.c_void_p
        gdi32.CreateEnhMetaFileW.restype = vp
        gdi32.CreateEnhMetaFileW.argtypes = [vp, wintypes.LPCWSTR, ctypes.POINTER(wintypes.RECT), wintypes.LPCWSTR]
        gdi32.CloseEnhMetaFile.restype = vp
        gdi32.CloseEnhMetaFile.argtypes = [vp]
        gdi32.GetEnhMetaFileBits.argtypes = [vp, wintypes.UINT, vp]
        gdi32.GetDeviceCaps.argtypes = [vp, ctypes.c_int]
        gdi32.GetStockObject.restype = vp
        gdi32.SelectObject.argtypes = [vp, vp]
        gdi32.Rectangle.argtypes = [vp, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int]
        gdi32.DeleteEnhMetaFile.argtypes = [vp]
        frame = wintypes.RECT(0, 0, 10000, 5000)
        dc = gdi32.CreateEnhMetaFileW(None, None, ctypes.byref(frame), None)
        px_per_mm = gdi32.GetDeviceCaps(dc, 8) / gdi32.GetDeviceCaps(dc, 4)
        gdi32.SelectObject(dc, gdi32.GetStockObject(4))
        w, h = round(100 * px_per_mm), round(50 * px_per_mm)
        gdi32.Rectangle(dc, 0, 0, w, h)
        gdi32.Rectangle(dc, w, h, w + round(20 * px_per_mm), h + round(20 * px_per_mm))
        hemf = gdi32.CloseEnhMetaFile(dc)
        n = gdi32.GetEnhMetaFileBits(hemf, 0, None)
        buf = ctypes.create_string_buffer(n)
        gdi32.GetEnhMetaFileBits(hemf, n, buf)
        gdi32.DeleteEnhMetaFile(hemf)
        return buf.raw

    def test_output_size_follows_frame_and_overflow_is_clipped(self):
        import emf

        data = self._emf()
        info = emf.header(data)
        self.assertGreater(info["bounds_mm"][2], info["frame_box_mm"][2] + 10)
        img = emf.render(data, 96)
        self.assertEqual(img.size, (round(100.01 / 25.4 * 96), round(50.01 / 25.4 * 96)))
        gray = np.asarray(img.convert("L"))
        self.assertLess(gray[5:-5, 5:-5].mean(), 10)


if __name__ == "__main__":
    unittest.main()
