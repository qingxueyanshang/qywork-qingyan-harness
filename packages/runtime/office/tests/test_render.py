"""覆盖 render.py 的 segments、seed_docx、rasterize，view 在缓存命中时的整页、局部与缺页处理，
以及 PDF 原件按页栅格化与无法打开的 PDF（均不启动办公软件）。"""

import unittest

from helpers import TempDir

import render
import util


class NoApps:
    residue = []

    def get(self, fmt):
        raise AssertionError("缓存命中时不应启动办公软件")


def pdf_with_pages(path, n):
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument.new()
    for _ in range(n):
        pdf.new_page(595, 842)
    pdf.save(str(path))
    pdf.close()
    return path


class SegmentsTest(unittest.TestCase):
    def test_segments(self):
        self.assertEqual(render.segments(1, 200, [52, 103, 154]),
                         [(1, 51), (52, 102), (103, 153), (154, 200)])
        self.assertEqual(render.segments(1, 12, [10]), [(1, 9), (10, 12)])
        self.assertEqual(render.segments(5, 9, []), [(5, 9)])
        self.assertEqual(render.segments(1, 10, [1, 11]), [(1, 10)])


class SeedViewTest(unittest.TestCase):
    def test_seed_then_view(self):
        from PIL import Image

        with TempDir() as d:
            doc = d / "a.docx"
            doc.write_bytes(b"not really a docx")
            pdf = pdf_with_pages(d / "a.pdf", 2)
            cache = d / "cache"
            render.seed_docx(doc, pdf, cache, {"progid": "KWPS.Application"})
            manifest = util.read_json(cache / util.sha256(doc) / "manifest.json")
            self.assertEqual([p["key"] for p in manifest["pages"]], ["1", "2"])
            w, h = manifest["pages"][0]["width"], manifest["pages"][0]["height"]
            self.assertAlmostEqual(w / 595, render.DPI / 72, delta=0.02)

            _, images, missing = render.view(doc, "docx", ["1", "3"], None, cache, d, NoApps())
            self.assertEqual(missing, ["3"])
            self.assertEqual(images[0]["label"], "第 1 页")
            _, images, _ = render.view(doc, "docx", ["2"], {"left": 0, "top": 0.5, "width": 0.5,
                                                            "height": 0.5}, cache, d, NoApps())
            crop = images[0]
            self.assertIn("局部", crop["label"])
            with Image.open(crop["path"]) as im:
                self.assertEqual(im.size, (round(w / 2), h - round(h / 2)))


class PdfViewTest(unittest.TestCase):
    def test_only_viewed_pages_are_rasterized(self):
        import os

        with TempDir() as d:
            pdf = pdf_with_pages(d / "a.pdf", 3)
            cache = d / "cache"
            _, images, missing = render.view(pdf, "pdf", ["2", "9"], None, cache, d, NoApps())
            self.assertEqual(missing, ["9"])
            self.assertEqual([i["label"] for i in images], ["第 2 页"])
            self.assertAlmostEqual(images[0]["width"] / 595, render.DPI / 72, delta=0.02)
            pages = util.read_json(cache / util.sha256(pdf) / "manifest.json")["pages"]
            self.assertEqual(len(pages), 3)
            self.assertFalse(os.path.exists(pages[0]["png"]))
            first = os.path.getmtime(images[0]["path"])

            _, again, _ = render.view(pdf, "pdf", ["2"], None, cache, d, NoApps())
            self.assertEqual(os.path.getmtime(again[0]["path"]), first)
            _, crop, _ = render.view(pdf, "pdf", ["3"], {"left": 0.5, "top": 0, "width": 0.5, "height": 0.5},
                                     cache, d, NoApps())
            self.assertIn("局部", crop[0]["label"])
            self.assertLess(crop[0]["width"], images[0]["width"])

    def test_unreadable_pdf_raises_with_name(self):
        with TempDir() as d:
            bad = d / "bad.pdf"
            bad.write_bytes(b"not a pdf at all")
            with self.assertRaises(render.Unreadable) as cm:
                render.view(bad, "pdf", ["1"], None, d / "cache", d, NoApps())
            self.assertIn("bad.pdf", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
