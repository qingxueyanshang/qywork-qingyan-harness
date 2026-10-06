"""覆盖 com.py 的组件规则表（rule_for）、宿主进程号解析（host_of）、残留扫描排除本调用实例
（foreign_residue）与异常结束后的清理（cleanup）。

cleanup 用本测试自行启动的子进程代替办公软件进程，不启动 WPS / Office。
"""

import subprocess
import sys
import time
import unittest

import psutil
from helpers import TempDir

import com
import util


class RuleTest(unittest.TestCase):
    def test_rules(self):
        self.assertEqual(com.rule_for("KWPS.Application", "12.1.0.28505"), "end")
        self.assertEqual(com.rule_for("KWPP.Application", "12.2.0.1"), "end")
        self.assertEqual(com.rule_for("KWPS.Application", "11.1.0.1"), "report")
        self.assertEqual(com.rule_for("Word.Application", "16.0.1"), "report")
        self.assertEqual(com.rule_for("KET.Application", None), "report")

    def test_host_of(self):
        cmd = r"et.exe /et /from_prome /prome-pipe-token=kprometheus.8088.11904.8152 /Automation"
        self.assertEqual(com.host_of(cmd), 8088)
        self.assertIsNone(com.host_of("wps.exe /prometheus /wps /Automation"))


class ResidueTest(unittest.TestCase):
    def test_own_instances_are_not_residue(self):
        rows = [{"pid": 11, "name": "wps.exe", "cmdline": "/Automation"},
                {"pid": 22, "name": "et.exe", "cmdline": "/Automation"}]
        original = com.automation_residue
        com.automation_residue = lambda: rows
        try:
            with TempDir() as d:
                util.write_json(d / "instances.json", [{"pid": 11, "status": "closed"}])
                self.assertEqual([r["pid"] for r in com.foreign_residue(d)], [22])
        finally:
            com.automation_residue = original


class CleanupTest(unittest.TestCase):
    def spawn(self):
        p = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
        time.sleep(0.3)
        return p

    def entry(self, p, rule, create_time=None):
        return {"pid": p.pid, "create_time": create_time or psutil.Process(p.pid).create_time(),
                "rule": rule, "role": "component", "status": "running", "progid": "KWPS.Application"}

    def test_ends_only_matching_end_rule(self):
        a, b, c = self.spawn(), self.spawn(), self.spawn()
        try:
            with TempDir() as d:
                util.write_json(d / "instances.json", [
                    self.entry(a, "end"),
                    self.entry(b, "report"),
                    self.entry(c, "end", create_time=1.0),
                ])
                report = {r["pid"]: r["action"] for r in com.cleanup(d)}
                self.assertEqual(report[a.pid], "ended")
                self.assertEqual(report[b.pid], "reported")
                self.assertEqual(report[c.pid], "already_exited")
                self.assertIsNotNone(a.wait(10))
                self.assertIsNone(b.poll())
                self.assertIsNone(c.poll())
                statuses = {e["pid"]: e["status"] for e in util.read_json(d / "instances.json")}
                self.assertEqual(statuses[a.pid], "ended_by_pid")
        finally:
            for p in (a, b, c):
                if p.poll() is None:
                    p.kill()
                    p.wait(10)

    def test_closed_entries_are_left_alone(self):
        p = self.spawn()
        try:
            with TempDir() as d:
                e = self.entry(p, "end")
                e["status"] = "closed"
                util.write_json(d / "instances.json", [e])
                self.assertEqual(com.cleanup(d)[0]["action"], "already_closed")
                self.assertIsNone(p.poll())
        finally:
            p.kill()
            p.wait(10)


if __name__ == "__main__":
    unittest.main()
