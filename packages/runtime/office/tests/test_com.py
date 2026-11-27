"""覆盖 com.py 的组件规则表（rule_for）、宿主进程号解析（host_of）、残留扫描排除本调用实例
（foreign_residue）与异常结束后的清理（cleanup），包括启动后、登记前被结束的进程（starting 记录）。

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



class UnregisteredCleanupTest(unittest.TestCase):
    """原始失败形状：办公软件进程已启动、登记尚未写入时 worker 被结束，cleanup 读取到的登记为空，
    报告「已结束 0 个」，两个 WPS 自动化进程一直留在后台。"""

    def setUp(self):
        self.procs = {}
        self.original = (com._procs, com.Lock)
        com._procs = lambda: dict(self.procs)

        class FreeLock:
            def __init__(self, timeout_s=60):
                pass

            def acquire(self):
                pass

            def release(self):
                pass

        com.Lock = FreeLock

    def tearDown(self):
        com._procs, com.Lock = self.original

    def spawn(self, cmdline):
        p = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
        time.sleep(0.3)
        self.procs[p.pid] = {"create_time": psutil.Process(p.pid).create_time(), "cmdline": cmdline}
        return p

    def marker(self, rule, started_at, before):
        return {"role": "starting", "marker": "m1", "status": "starting", "rule": rule,
                "progid": "KWPS.Application", "started_at": started_at, "before": before}

    def test_ends_processes_started_after_the_record(self):
        old = self.spawn("wps.exe /prometheus /wps /Automation -Embedding")
        started_at = time.time()
        host = self.spawn("wps.exe /prometheus /wps /Automation -Embedding")
        component = self.spawn("wps.exe /wps /from_prome /Automation -Embedding")
        interactive = self.spawn("wps.exe report.docx")
        try:
            with TempDir() as d:
                util.write_json(d / "instances.json", [self.marker("end", started_at, [old.pid])])
                report = {r["pid"]: r["action"] for r in com.cleanup(d)}
                self.assertEqual(report, {host.pid: "ended", component.pid: "ended"})
                self.assertIsNotNone(host.wait(10))
                self.assertIsNotNone(component.wait(10))
                self.assertIsNone(old.poll())
                self.assertIsNone(interactive.poll())
                saved = util.read_json(d / "instances.json")
                self.assertEqual([e["status"] for e in saved if e["role"] == "starting"], ["resolved"])
        finally:
            for p in (old, host, component, interactive):
                if p.poll() is None:
                    p.kill()
                    p.wait(10)

    def test_processes_started_after_the_worker_ended_are_left_alone(self):
        """worker 被结束后、清理取得锁之前，其他调用持锁启动的进程晚于 worker 结束的时刻，不补登记、不结束。"""
        started_at = time.time()
        own = self.spawn("wps.exe /prometheus /wps /Automation -Embedding")
        ended_at = time.time()
        time.sleep(0.05)
        other = self.spawn("wps.exe /prometheus /wps /Automation -Embedding")
        try:
            with TempDir() as d:
                util.write_json(d / "instances.json", [self.marker("end", started_at, [])])
                report = {r["pid"]: r["action"] for r in com.cleanup(d, ended_at=ended_at)}
                self.assertEqual(report, {own.pid: "ended"})
                self.assertIsNotNone(own.wait(10))
                self.assertIsNone(other.poll())
        finally:
            for p in (own, other):
                if p.poll() is None:
                    p.kill()
                    p.wait(10)

    def test_component_of_own_host_is_ended_even_if_started_later(self):
        """宿主在 worker 结束之后才启动组件：组件命令行中的宿主进程号指向本调用的宿主时一并结束。"""
        started_at = time.time()
        host = self.spawn("wps.exe /prometheus /wps /Automation -Embedding")
        ended_at = time.time()
        time.sleep(0.05)
        component = self.spawn(
            f"wps.exe /wps /from_prome /prome-pipe-token=kprometheus.{host.pid}.1.2 /Automation -Embedding")
        try:
            with TempDir() as d:
                util.write_json(d / "instances.json", [self.marker("end", started_at, [])])
                report = {r["pid"]: r["action"] for r in com.cleanup(d, ended_at=ended_at)}
                self.assertEqual(report, {host.pid: "ended", component.pid: "ended"})
        finally:
            for p in (host, component):
                if p.poll() is None:
                    p.kill()
                    p.wait(10)

    def test_unverified_component_is_only_reported(self):
        started_at = time.time()
        p = self.spawn("WINWORD.EXE /Automation -Embedding")
        try:
            with TempDir() as d:
                util.write_json(d / "instances.json", [self.marker("report", started_at, [])])
                self.assertEqual([r["action"] for r in com.cleanup(d)], ["reported"])
                self.assertIsNone(p.poll())
        finally:
            p.kill()
            p.wait(10)

    def test_settled_records_are_ignored(self):
        started_at = time.time()
        p = self.spawn("wps.exe /prometheus /wps /Automation -Embedding")
        try:
            with TempDir() as d:
                m = self.marker("end", started_at, [])
                m["status"] = "registered"
                util.write_json(d / "instances.json", [m])
                self.assertEqual(com.cleanup(d), [])
                self.assertIsNone(p.poll())
        finally:
            p.kill()
            p.wait(10)


if __name__ == "__main__":
    unittest.main()
