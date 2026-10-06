"""覆盖 worker.py：请求校验、目标冲突、脚本 API 的输出路径对应、脚本执行、没有办公软件时的 write 流水线、
probe / guide / main 的响应文件、加密文件的拒绝、PDF 原件只进 view 不进 read，以及 util.py 的格式判定、宏检测、加密判定与原子替换。
"""

import sys
import unittest
import zipfile

from helpers import TempDir

import com
import util
import worker


class NoApps:
    """测试不启动办公软件：每次取得实例都报告不可用。"""

    residue = []

    def __init__(self, *args):
        pass

    def get(self, fmt):
        raise com.Unavailable("测试环境不启动办公软件")

    def close(self):
        return {}


def stages(resp, file=None):
    return {s["name"]: s["status"] for s in resp["stages"] if file is None or s["file"] in (file, None)}


class UtilTest(unittest.TestCase):
    def test_fmt_macros_copy(self):
        self.assertEqual(util.fmt_of("a/b.DOCX"), "docx")
        self.assertIsNone(util.fmt_of("a.docm"))
        with TempDir() as d:
            self.assertTrue(util.has_macros(d / "x.xlsm"))
            with zipfile.ZipFile(d / "y.xlsx", "w") as z:
                z.writestr("xl/vbaProject.bin", b"x")
            self.assertTrue(util.has_macros(d / "y.xlsx"))
            (d / "src").write_bytes(b"new")
            (d / "dst").write_bytes(b"old")
            util.atomic_copy(d / "src", d / "dst")
            self.assertEqual((d / "dst").read_bytes(), b"new")
            self.assertEqual(sorted(p.name for p in d.iterdir()), ["dst", "src", "y.xlsx"])
        self.assertEqual(util.col_letter(28), "AB")


class ValidateTest(unittest.TestCase):
    def test_problems(self):
        with TempDir() as d:
            (d / "s.py").write_text("pass", "utf-8")
            ok = {"script": str(d / "s.py"), "outputs": [{"path": str(d / "a.docx")}]}
            self.assertEqual(worker.validate_write(ok), [])
            bad = {"script": str(d / "none.py"),
                   "outputs": [{"path": str(d / "a.docm")}, {"path": str(d / "b.xlsx")},
                               {"path": str(d / "B.xlsx")}],
                   "inputs": [str(d / "missing.png")],
                   "pdf": [{"source": str(d / "c.docx"), "path": str(d / "c.txt")}]}
            got = "\n".join(worker.validate_write(bad))
            for word in ("none.py", "a.docm", "重复", "missing.png", "c.docx", "c.txt"):
                if word == "重复" and sys.platform != "win32":
                    continue
                self.assertIn(word, got)

    def test_conflicts(self):
        with TempDir() as d:
            (d / "a.docx").write_bytes(b"x")
            sha = util.sha256(d / "a.docx")
            self.assertEqual(worker.check_targets([{"path": str(d / "new.docx")}]), [])
            self.assertEqual(worker.check_targets([{"path": str(d / "a.docx"),
                                                    "expected_sha256": sha}]), [])
            self.assertIn("已存在", worker.check_targets([{"path": str(d / "a.docx")}])[0])
            self.assertIn("被改动过", worker.check_targets([{"path": str(d / "a.docx"),
                                                          "expected_sha256": "0" * 64}])[0])
            self.assertIn("被删除", worker.check_targets([{"path": str(d / "gone.docx"),
                                                         "expected_sha256": "0" * 64}])[0])


class ContextTest(unittest.TestCase):
    def test_output_mapping(self):
        with TempDir() as d:
            works = [({"path": str(d / "out" / "r.docx")}, "docx", d / "work" / "0-r.docx")]
            ctx = worker.OfficeContext(d, d / "call", [], works)
            self.assertEqual(ctx.output("out/r.docx"), str(d / "work" / "0-r.docx"))
            self.assertEqual(ctx.output(str(d / "out" / "r.docx")), str(d / "work" / "0-r.docx"))
            with self.assertRaises(KeyError):
                ctx.output("other.docx")

    def test_run_script(self):
        with TempDir() as d:
            ctx = worker.OfficeContext(d, d, [], [])
            (d / "ok.py").write_text("print('你好')\nfrom qyoffice import office as o\n"
                                     "assert o is office\n", "utf-8")
            ok, out = worker.run_script(d / "ok.py", ctx)
            self.assertTrue(ok, out)
            self.assertIn("你好", out)
            (d / "bad.py").write_text("raise RuntimeError('坏了')\n", "utf-8")
            ok, out = worker.run_script(d / "bad.py", ctx)
            self.assertFalse(ok)
            self.assertIn("RuntimeError", out)
            (d / "exit.py").write_text("import sys\nsys.exit(0)\n", "utf-8")
            self.assertTrue(worker.run_script(d / "exit.py", ctx)[0])


SCRIPT = """
from docx import Document
doc = Document()
doc.add_paragraph("正文")
doc.save(office.output("out/r.docx"))
"""


class WriteTest(unittest.TestCase):
    def request(self, d, **extra):
        (d / "call").mkdir(exist_ok=True)
        (d / "make.py").write_text(SCRIPT, "utf-8")
        return {"action": "write", "call_dir": str(d / "call"), "workspace": str(d),
                "cache_dir": str(d / "cache"), "script": str(d / "make.py"),
                "outputs": [{"path": str(d / "out" / "r.docx"), "expected_sha256": None}],
                **extra}

    def test_write_without_apps_commits_and_reports_unavailable(self):
        with TempDir() as d:
            resp = worker.Response("write")
            worker.do_write(self.request(d), resp, apps_factory=NoApps)
            self.assertTrue(resp["ok"], resp.data)
            final = str(d / "out" / "r.docx")
            st = stages(resp, final)
            self.assertEqual(st["execute"], "completed")
            self.assertEqual(st["render"], "unavailable")
            self.assertEqual(st["commit"], "completed")
            f = resp["files"][0]
            self.assertTrue(f["committed"])
            self.assertEqual(f["sha256"], util.sha256(final))
            self.assertIn("east_asia_font_missing", [c["code"] for c in f["checks"]])

    def test_existing_target_without_expected_is_not_touched(self):
        with TempDir() as d:
            (d / "out").mkdir()
            (d / "out" / "r.docx").write_bytes(b"user bytes")
            resp = worker.Response("write")
            worker.do_write(self.request(d), resp, apps_factory=NoApps)
            self.assertFalse(resp["ok"])
            self.assertEqual(stages(resp)["execute"], "not_run")
            self.assertEqual((d / "out" / "r.docx").read_bytes(), b"user bytes")

    def test_script_error_commits_nothing(self):
        with TempDir() as d:
            req = self.request(d)
            (d / "make.py").write_text("raise ValueError('x')\n", "utf-8")
            resp = worker.Response("write")
            worker.do_write(req, resp, apps_factory=NoApps)
            self.assertFalse(resp["ok"])
            self.assertEqual(stages(resp)["execute"], "failed")
            self.assertIn("ValueError", resp["script_output"])
            self.assertFalse((d / "out" / "r.docx").exists())

    def test_missing_output_is_reported(self):
        with TempDir() as d:
            req = self.request(d)
            (d / "make.py").write_text("pass\n", "utf-8")
            resp = worker.Response("write")
            worker.do_write(req, resp, apps_factory=NoApps)
            self.assertFalse(resp["ok"])
            self.assertEqual(stages(resp, str(d / "out" / "r.docx"))["commit"], "not_run")


class MainTest(unittest.TestCase):
    def test_probe_and_guide_write_response(self):
        with TempDir() as d:
            for action, extra in (("probe", {}), ("guide", {"format": "docx"}),
                                  ("guide", {"format": "odt"}), ("nope", {})):
                util.write_json(d / "request.json", {"action": action, "call_dir": str(d), **extra})
                self.assertEqual(worker.main(["worker.py", str(d / "request.json")]), 0)
                resp = util.read_json(d / "response.json")
                if action == "probe":
                    self.assertIn("packages", resp["probe"])
                    self.assertEqual(set(resp["probe"]["apps"]), {"docx", "xlsx", "pptx"})
                elif extra.get("format") == "docx":
                    self.assertTrue(resp["ok"])
                    self.assertIn("office.output", resp["text"])
                else:
                    self.assertFalse(resp["ok"])


class ReadableTest(unittest.TestCase):
    def test_encrypted_file_is_rejected_with_reason(self):
        with TempDir() as d:
            (d / "locked.docx").write_bytes(bytes.fromhex("d0cf11e0a1b11ae1") + b"\0" * 512)
            for action in ("read", "view"):
                util.write_json(d / "request.json", {"action": action, "call_dir": str(d),
                                                     "path": str(d / "locked.docx"), "pages": ["1"],
                                                     "cache_dir": str(d)})
                worker.main(["worker.py", str(d / "request.json")])
                resp = util.read_json(d / "response.json")
                self.assertFalse(resp["ok"])
                self.assertIn("已加密", resp["message"])


class PdfTest(unittest.TestCase):
    def _run(self, d, action, path):
        util.write_json(d / "request.json", {"action": action, "call_dir": str(d), "path": str(path),
                                             "pages": ["1"], "cache_dir": str(d / "cache")})
        worker.main(["worker.py", str(d / "request.json")])
        return util.read_json(d / "response.json")

    def test_view_accepts_pdf_and_read_does_not(self):
        import pypdfium2 as pdfium

        with TempDir() as d:
            pdf = pdfium.PdfDocument.new()
            pdf.new_page(595, 842)
            pdf.save(str(d / "a.pdf"))
            pdf.close()
            resp = self._run(d, "view", d / "a.pdf")
            self.assertTrue(resp["ok"], resp["message"])
            self.assertEqual(len(resp["images"]), 1)
            self.assertEqual(resp["files"][0]["pages"], 1)
            resp = self._run(d, "read", d / "a.pdf")
            self.assertFalse(resp["ok"])
            self.assertIn("不是 docx / pptx / xlsx", resp["message"])

    def test_broken_pdf_view_reports_reason(self):
        with TempDir() as d:
            (d / "broken.pdf").write_bytes(b"%PDF-1.7 truncated")
            resp = self._run(d, "view", d / "broken.pdf")
            self.assertFalse(resp["ok"])
            self.assertIn("无法渲染", resp["message"])
            self.assertIn("broken.pdf", resp["message"])


if __name__ == "__main__":
    unittest.main()
