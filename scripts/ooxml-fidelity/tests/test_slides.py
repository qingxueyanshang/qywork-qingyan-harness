"""覆盖 slides.py 的纯逻辑（导出尺寸换算、分块 SSIM、导出图与缩略图的比较、不一致原因的分类、拒绝写入的判定、
按放映顺序取每页使用的嵌入且未安装的字体、关系目标按 OPC 规则解析）与 clipboard.dib_image（CF_DIB 解码）。

运行：python -m unittest discover -s scripts/ooxml-fidelity/tests
临时文件位于 .tmp/ooxml-fidelity/tests-slides。
"""

import io
import shutil
import sys
import unittest
import zipfile
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
TMP = HERE.parents[2] / ".tmp" / "ooxml-fidelity" / "tests-slides"

import numpy as np  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

if sys.platform == "win32":
    import clipboard  # noqa: E402
    import slides  # noqa: E402

MISSING = "qywork 测试用不存在字体"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG = "http://schemas.openxmlformats.org/package/2006/relationships"


def _slide(size=(1280, 720), mark=True) -> Image.Image:
    img = Image.new("RGB", size, (30, 60, 120))
    d = ImageDraw.Draw(img)
    rng = np.random.default_rng(7)
    for _ in range(60):
        x, y = int(rng.integers(0, size[0] - 120)), int(rng.integers(0, size[1] - 30))
        d.rectangle((x, y, x + 100, y + 14), fill="white")
    if mark:
        d.ellipse((1000, 500, 1160, 660), fill=(240, 200, 0))
    return img


def _rels(*items, extra="") -> str:
    body = "".join(f'<Relationship Id="{i}" Type="{REL}/{t}" Target="{target}"/>' for i, t, target in items)
    return f'<Relationships xmlns="{PKG}">{body}{extra}</Relationships>'


def _run(face: str) -> str:
    return f'<p:sp><p:txBody><a:p><a:r><a:rPr><a:ea typeface="{face}"/></a:rPr><a:t>字</a:t></a:r></a:p></p:txBody></p:sp>'


def _pptx(path: Path, absolute=False):
    """两页：放映顺序第 1 页是 slide2.xml（用主题东亚字体），第 2 页是 slide1.xml（用 Arial）。主题东亚字体为嵌入且未安装的字体。

    absolute 为真时演示文稿与幻灯片的关系目标写为包内绝对路径（以 `/` 开头），并另含一个外部超链接关系。
    """
    theme = (f'<a:theme><a:majorFont><a:latin typeface="Arial"/></a:majorFont>'
             f'<a:minorFont><a:latin typeface="Arial"/><a:ea typeface="{MISSING}"/></a:minorFont></a:theme>')
    pres = ('<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst>'
            f'<p:embeddedFontLst><p:embeddedFont><p:font typeface="{MISSING}"/></p:embeddedFont>'
            '<p:embeddedFont><p:font typeface="Arial"/></p:embeddedFont></p:embeddedFontLst></p:presentation>')
    base = "/ppt/" if absolute else ""
    layout = "/ppt/slideLayouts/slideLayout1.xml" if absolute else "../slideLayouts/slideLayout1.xml"
    link = (f'<Relationship Id="rIdX" Type="{REL}/hyperlink" Target="https://example.com/a/../../b" '
            'TargetMode="External"/>') if absolute else ""
    parts = {
        "ppt/presentation.xml": pres,
        "ppt/_rels/presentation.xml.rels": _rels(("rId2", "slide", f"{base}slides/slide1.xml"),
                                                 ("rId3", "slide", f"{base}slides/slide2.xml"), extra=link),
        "ppt/slides/slide1.xml": f"<p:sld><p:cSld><p:spTree>{_run('Arial')}</p:spTree></p:cSld></p:sld>",
        "ppt/slides/slide2.xml": f"<p:sld><p:cSld><p:spTree>{_run('+mn-ea')}</p:spTree></p:cSld></p:sld>",
        "ppt/slides/_rels/slide1.xml.rels": _rels(("rId1", "slideLayout", layout), extra=link),
        "ppt/slides/_rels/slide2.xml.rels": _rels(("rId1", "slideLayout", layout)),
        "ppt/slideLayouts/slideLayout1.xml": "<p:sldLayout><p:cSld><p:spTree/></p:cSld></p:sldLayout>",
        "ppt/slideLayouts/_rels/slideLayout1.xml.rels": _rels(("rId1", "slideMaster",
                                                                "../slideMasters/slideMaster1.xml")),
        "ppt/slideMasters/slideMaster1.xml": "<p:sldMaster><p:cSld><p:spTree/></p:cSld></p:sldMaster>",
        "ppt/slideMasters/_rels/slideMaster1.xml.rels": _rels(("rId1", "theme", "../theme/theme1.xml")),
        "ppt/theme/theme1.xml": theme,
    }
    with zipfile.ZipFile(path, "w") as z:
        for name, xml in parts.items():
            z.writestr(name, xml)


@unittest.skipUnless(sys.platform == "win32", "clipboard 模块与字体枚举依赖 Windows 接口")
class SlidesTest(unittest.TestCase):
    def test_export_size_follows_96_dpi(self):
        self.assertEqual(slides.export_size(960, 540), (1280, 720))
        self.assertEqual(slides.export_size(720, 540), (960, 720))
        self.assertEqual(slides.export_size(960, 540, 192), (2560, 1440))

    def test_block_min_finds_the_lowest_block(self):
        m = np.ones((60, 80))
        m[50:60, 70:80] = 0.2
        self.assertAlmostEqual(slides.block_min(m, (6, 8)), 0.2)
        self.assertAlmostEqual(slides.block_min(np.ones((60, 80))), 1.0)

    def test_same_content_passes_and_local_difference_is_caught(self):
        export = _slide()
        thumb = export.resize((640, 360), Image.BOX)
        same = slides.compare(export, thumb)
        self.assertEqual(same["ssim"], 1.0)
        self.assertTrue(slides.consistent(same))
        missing = slides.compare(_slide(mark=False), thumb)
        self.assertGreater(missing["ssim"], slides.MIN_SSIM)
        self.assertLess(missing["min_block"], slides.MIN_BLOCK)
        self.assertFalse(slides.consistent(missing))

    def test_classify_by_embedded_font_and_review(self):
        bad = {"n": 3, "ssim": 0.8, "min_block": 0.2}
        self.assertIsNone(slides.classify({"n": 1, "ssim": 1.0, "min_block": 1.0, "embedded_fonts": []},
                                          {})["difference"])
        self.assertEqual(slides.classify({**bad, "embedded_fonts": ["华文行楷"]}, {})["difference"], "嵌入字体")
        accepted = slides.classify({**bad, "embedded_fonts": []}, {3: "替代字体宽度不同"})
        self.assertEqual(accepted, {"difference": "人工核对接受", "note": "替代字体宽度不同"})
        self.assertEqual(slides.classify({**bad, "embedded_fonts": []}, {})["difference"], "其他")

    def test_rejection_only_for_other_causes_and_size_mismatch(self):
        ok = {"other_pages": [], "size_mismatch_pages": [], "embedded_font_pages": [1, 3], "accepted_pages": [10]}
        self.assertIsNone(slides.rejection(ok))
        bad = slides.rejection({**ok, "other_pages": [4], "size_mismatch_pages": [5]})
        self.assertIn("[4]", bad)
        self.assertIn("[5]", bad)

    def test_embedded_faces_follow_show_order_and_resolve_theme_fonts(self):
        shutil.rmtree(TMP, ignore_errors=True)
        TMP.mkdir(parents=True)
        path = TMP / "fonts.pptx"
        _pptx(path)
        self.assertTrue(slides.installed("Arial"))
        self.assertFalse(slides.installed(MISSING))
        self.assertEqual(slides.embedded_faces(path), [[MISSING], []])

    def test_absolute_relationship_targets_resolve_from_package_root(self):
        shutil.rmtree(TMP, ignore_errors=True)
        TMP.mkdir(parents=True)
        path = TMP / "absolute.pptx"
        _pptx(path, absolute=True)
        with zipfile.ZipFile(path) as z:
            self.assertEqual(slides._rels(z, "ppt/presentation.xml"),
                             [("rId2", f"{REL}/slide", "ppt/slides/slide1.xml"),
                              ("rId3", f"{REL}/slide", "ppt/slides/slide2.xml")])
            self.assertEqual(slides._target(z, "ppt/slides/slide1.xml", "slideLayout"),
                             "ppt/slideLayouts/slideLayout1.xml")
        self.assertEqual(slides.embedded_faces(path), [[MISSING], []])

    def test_dib_image_decodes_bitmap_without_file_header(self):
        img = _slide().resize((64, 36), Image.BOX)
        buf = io.BytesIO()
        img.save(buf, "BMP")
        decoded = clipboard.dib_image(buf.getvalue()[14:])
        self.assertEqual(decoded.size, (64, 36))
        self.assertTrue(np.array_equal(np.asarray(decoded), np.asarray(img)))


if __name__ == "__main__":
    unittest.main()
