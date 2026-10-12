#!/usr/bin/env python3
"""Behavioral checks for the SSH-side workspace helper; no network or model calls."""
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import select
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
import uuid
import zipfile


HELPER = Path(__file__).with_name("remote-workspace.py")

MOCK_CODEX = r'''#!/usr/bin/env python3
import json
import os
import subprocess
import sys

if "--version" in sys.argv:
    print("codex-cli 0.160.0")
    raise SystemExit(0)
keys = ("NEW_API_KEY", "NEW_API_BASE_URL", "GH_TOKEN", "GITHUB_TOKEN",
        "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0",
        "HOME", "CODEX_HOME", "PYTHONPATH", "LD_PRELOAD", "GIT_SSH_COMMAND",
        "REMOTE_TEST_PARENT_SECRET")
for line in sys.stdin:
    request = json.loads(line)
    result = {"argv": sys.argv[1:], "cwd": os.getcwd(), "pid": os.getpid(),
              "env": {key: os.environ[key] for key in keys if key in os.environ}}
    if request.get("method") == "hold":
        child = subprocess.Popen([sys.executable, "-I", "-c", "import time; time.sleep(300)"])
        result["childPid"] = child.pid
    print(json.dumps({"jsonrpc": "2.0", "id": request.get("id"), "result": result}), flush=True)
'''


class RemoteWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="new-api-remote-helper-test-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.home = self.base / "home"
        self.home.mkdir(mode=0o700)
        self.root = self.home / "project"
        self.root.mkdir()
        self.bin = self.base / "bin"
        self.bin.mkdir()
        self.external = self.base / "external-control"
        self.external.mkdir(mode=0o700)
        mock = self.bin / "codex"
        mock.write_text(MOCK_CODEX)
        mock.chmod(0o755)
        self.workspace = str(uuid.uuid4())
        self.control = self.home / ".local/share/new-api-codex"
        self.env = {
            "HOME": str(self.home),
            "PATH": f"{self.bin}:/usr/local/bin:/usr/bin:/bin",
            "LANG": "C.UTF-8",
            "NEW_API_CODEX_REMOTE_CONTROL_PARENT": str(self.external),
            "REMOTE_TEST_PARENT_SECRET": "not-for-the-codex-process",
        }

    def command(self, operation, root=None, workspace=None):
        return [sys.executable, "-I", str(HELPER), operation,
                str(self.root if root is None else root), workspace or self.workspace]

    def invoke(self, operation, request=None, *, root=None, workspace=None):
        result = subprocess.run(
            self.command(operation, root, workspace),
            input="" if request is None else json.dumps(request),
            capture_output=True, text=True, env=self.env, timeout=15,
        )
        self.assertTrue(result.stdout.strip(), result.stderr)
        try:
            envelope = json.loads(result.stdout)
        except ValueError:
            self.fail(f"Helper returned non-JSON output: {result.stdout!r}; stderr={result.stderr!r}")
        self.assertIsInstance(envelope.get("ok"), bool, envelope)
        if envelope["ok"]:
            self.assertEqual(result.returncode, 0, result.stderr)
        return envelope

    def success(self, operation, request=None, **kwargs):
        envelope = self.invoke(operation, request, **kwargs)
        self.assertTrue(envelope["ok"], envelope)
        return envelope["result"]

    def assert_rejected(self, operation, request=None, **kwargs):
        envelope = self.invoke(operation, request, **kwargs)
        self.assertFalse(envelope["ok"], envelope)
        return envelope

    def assert_private_tree(self):
        self.assertTrue(self.control.is_dir())
        for path in [self.control, *self.control.rglob("*")]:
            if path.is_symlink():
                continue
            self.assertEqual(stat.S_IMODE(path.stat().st_mode) & 0o077, 0, str(path))

    def test_binary_upload_uses_remote_project_and_rejects_existing_names(self):
        content = b"\x89PNG\x00\xffbinary"
        request = {"operation": "upload", "path": "assets/图片.png", "data": base64.b64encode(content).decode()}
        first = self.invoke("file", request)
        self.assertTrue(first["ok"], first)
        self.assertEqual(first["result"], {"path": "assets/图片.png", "size": len(content)})
        self.assertEqual((self.root / "assets/图片.png").read_bytes(), content)
        conflict = self.invoke("file", request)
        self.assertFalse(conflict["ok"])
        self.assertEqual(conflict["code"], "file_conflict")
        self.assertEqual((self.root / "assets/图片.png").read_bytes(), content)

    def test_prepare_uses_a_private_control_tree_outside_the_project(self):
        result = self.success("prepare")
        self.assertEqual(Path(result["root"]), self.root)
        self.assertTrue(Path(result["home"]).is_relative_to(self.control))
        self.assertFalse(Path(result["home"]).is_relative_to(self.root))
        self.assertTrue(result["capabilities"]["files"])
        self.assertTrue(result["capabilities"]["appServer"])
        self.assert_private_tree()
        self.assertEqual(list(self.root.iterdir()), [])

    def test_home_project_preserves_existing_files_and_keeps_session_state_outside_home(self):
        existing = self.home / "server-config.txt"
        existing.write_text("keep server config\n")
        result = self.success("prepare", root=self.home)
        project_home = Path(result["home"])
        self.assertFalse(project_home.is_relative_to(self.home))
        self.assertTrue(project_home.is_relative_to(self.external))
        self.assertEqual(stat.S_IMODE(project_home.stat().st_mode), 0o700)
        self.assertEqual(existing.read_text(), "keep server config\n")
        created = self.success("file", {"operation": "write", "path": "notes.txt", "content": "manage home\n", "expectedHash": None}, root=self.home)
        self.assertEqual(created["path"], "notes.txt")
        self.assertEqual((self.home / "notes.txt").read_text(), "manage home\n")

    def test_home_project_hides_legacy_session_state_from_files_export_and_changes(self):
        self.control.mkdir(parents=True, mode=0o700)
        secret = self.control / "private-session.json"
        secret.write_text("fixture-session-credential")
        ordinary = self.control.parent / "ordinary-tool.txt"
        ordinary.write_text("manage this tool\n")
        self.success("prepare", root=self.home)
        listing = self.success("file", {"operation": "list", "path": ".local/share"}, root=self.home)
        self.assertEqual([entry["name"] for entry in listing["entries"]], ["ordinary-tool.txt"])
        protected = ".local/share/new-api-codex/private-session.json"
        self.assert_rejected("file", {"operation": "read", "path": protected}, root=self.home)
        self.assert_rejected("file", {"operation": "write", "path": protected, "content": "overwrite", "expectedHash": None}, root=self.home)
        self.success("git", {"operation": "baseline"}, root=self.home)
        secret.write_text("changed-fixture-session-credential")
        ordinary.write_text("changed tool\n")
        diff = self.success("git", {"operation": "diff"}, root=self.home)
        self.assertNotIn("new-api-codex", diff["diff"])
        self.assertIn("ordinary-tool.txt", diff["diff"])
        exported = self.success("file", {"operation": "export"}, root=self.home)
        with zipfile.ZipFile(io.BytesIO(base64.b64decode(exported["data"]))) as archive:
            self.assertNotIn(protected, archive.namelist())
            self.assertIn(".local/share/ordinary-tool.txt", archive.namelist())

    def test_home_project_rejects_external_control_symlinks_and_unsafe_permissions(self):
        name = 'new-api-codex-' + str(os.geteuid()) + '-' + hashlib.sha256(str(self.home).encode()).hexdigest()[:16]
        control = self.external / name
        outside = self.base / 'outside'
        outside.mkdir()
        control.symlink_to(outside, target_is_directory=True)
        self.assert_rejected('prepare', root=self.home)
        self.assertEqual(list(outside.iterdir()), [])
        control.unlink()
        control.mkdir(mode=0o777)
        control.chmod(0o777)
        self.assert_rejected('prepare', root=self.home)
        self.assertEqual(list(control.iterdir()), [])

    def test_prepare_rejects_root_and_control_tree_overlap(self):
        self.success("prepare")
        for root in [Path("/"), self.control, self.control / "projects"]:
            with self.subTest(root=str(root)):
                self.assert_rejected("prepare", root=root)
        sibling = self.control.with_name("new-api-codex-other")
        sibling.mkdir()
        self.success("prepare", root=sibling, workspace=str(uuid.uuid4()))

    def test_prepare_rejects_symbolic_link_roots_and_ancestors(self):
        link = self.home / "project-link"
        link.symlink_to(self.root, target_is_directory=True)
        self.assert_rejected("prepare", root=link)
        nested = self.root / "nested"
        nested.mkdir()
        self.assert_rejected("prepare", root=link / "nested")
        self.assertEqual(list(nested.iterdir()), [])

    def test_prepare_rejects_invalid_workspace_identifiers(self):
        for workspace in ["../../outside", "not-a-uuid", self.workspace + "\n"]:
            with self.subTest(workspace=workspace):
                self.assert_rejected("prepare", workspace=workspace)

    def test_control_directory_symlinks_cannot_redirect_private_state(self):
        outside = self.base / "outside"
        outside.mkdir()
        (self.home / ".local").symlink_to(outside, target_is_directory=True)
        self.assert_rejected("prepare")
        self.assertEqual(list(outside.iterdir()), [])

    def test_file_write_preserves_remote_ownership_and_conflict_detection(self):
        created = self.success("file", {
            "operation": "write", "path": "src/你好.txt", "content": "first\n", "expectedHash": None,
        })
        target = self.root / "src/你好.txt"
        for path in [target.parent, target]:
            self.assertEqual((path.stat().st_uid, path.stat().st_gid), (os.geteuid(), os.getegid()))
        self.assertEqual(created["hash"], hashlib.sha256(b"first\n").hexdigest())
        self.assert_rejected("file", {
            "operation": "write", "path": "src/你好.txt", "content": "lost update", "expectedHash": None,
        })
        self.assertEqual(target.read_text(), "first\n")
        self.success("file", {
            "operation": "write", "path": "src/你好.txt", "content": "second\n", "expectedHash": created["hash"],
        })
        read = self.success("file", {"operation": "read", "path": "src/你好.txt"})
        self.assertEqual(read["content"], "second\n")

    def test_file_access_rejects_traversal_and_symlinks_without_touching_outside(self):
        outside = self.base / "outside"
        outside.mkdir()
        sentinel = outside / "sentinel.txt"
        sentinel.write_text("keep private")
        before = sentinel.stat().st_mtime_ns
        (self.root / "link").symlink_to(outside, target_is_directory=True)
        (self.root / "linked.txt").symlink_to(sentinel)
        for path in ["../outside/sentinel.txt", str(sentinel), "link/sentinel.txt", "linked.txt", ".git/config"]:
            with self.subTest(path=path):
                self.assert_rejected("file", {"operation": "read", "path": path})
                self.assert_rejected("file", {
                    "operation": "write", "path": path, "content": "overwritten", "expectedHash": None,
                })
        listing = self.success("file", {"operation": "list", "path": ""})
        self.assertEqual(listing["entries"], [])
        exported = self.success("file", {"operation": "export"})
        with zipfile.ZipFile(io.BytesIO(base64.b64decode(exported["data"]))) as archive:
            self.assertEqual(archive.namelist(), [])
        self.assertEqual(sentinel.read_text(), "keep private")
        self.assertEqual(sentinel.stat().st_mtime_ns, before)

    def test_import_validates_entire_archive_before_writing(self):
        archive_bytes = io.BytesIO()
        with zipfile.ZipFile(archive_bytes, "w") as archive:
            archive.writestr("valid.txt", "must not be written")
            archive.writestr("../escape.txt", "escape")
        self.assert_rejected("file", {
            "operation": "import", "data": base64.b64encode(archive_bytes.getvalue()).decode(),
        })
        self.assertEqual(list(self.root.iterdir()), [])
        self.assertFalse((self.home / "escape.txt").exists())

    def test_import_and_export_round_trip_without_exporting_credentials(self):
        archive_bytes = io.BytesIO()
        with zipfile.ZipFile(archive_bytes, "w") as archive:
            archive.writestr("src/app.py", "print('remote')\n")
        imported = self.success("file", {
            "operation": "import", "data": base64.b64encode(archive_bytes.getvalue()).decode(),
        })
        self.assertEqual(imported["files"], 1)
        target = self.root / "src/app.py"
        self.assertEqual((target.stat().st_uid, target.stat().st_gid), (os.geteuid(), os.getegid()))
        (self.root / ".env").write_text("TOKEN=fixture-only")
        (self.root / "private.key").write_text("fixture-private-key")
        result = self.success("file", {"operation": "export"})
        with zipfile.ZipFile(io.BytesIO(base64.b64decode(result["data"]))) as archive:
            self.assertEqual(archive.namelist(), ["src/app.py"])
            self.assertEqual(archive.read("src/app.py"), b"print('remote')\n")

    @unittest.skipUnless(shutil.which("git"), "git is required for the isolated baseline check")
    def test_git_baseline_and_diff_preserve_the_users_repository_and_staging(self):
        git_env = {**self.env, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_OPTIONAL_LOCKS": "0"}

        def git(*args):
            return subprocess.run(["git", *args], cwd=self.root, env=git_env,
                                  capture_output=True, check=True, timeout=10).stdout

        git("init", "--initial-branch=main")
        git("config", "user.name", "Remote fixture")
        git("config", "user.email", "fixture@localhost")
        tracked = self.root / "tracked.txt"
        tracked.write_text("committed\n")
        git("add", ".")
        git("commit", "-m", "Fixture initial commit")
        tracked.write_text("staged before baseline\n")
        git("add", "tracked.txt")
        hooks = self.base / "hooks"
        hooks.mkdir()
        hook_marker = self.base / "hook-was-run"
        hook = hooks / "pre-commit"
        hook.write_text(f"#!/bin/sh\nprintf executed > '{hook_marker}'\nexit 1\n")
        hook.chmod(0o755)
        git("config", "core.hooksPath", str(hooks))
        protected = [self.root / ".git" / name for name in ["HEAD", "index", "config"]]
        original = {path: path.read_bytes() for path in protected}
        staged = git("diff", "--cached", "--no-ext-diff")

        self.assertTrue(self.success("git", {"operation": "baseline"})["ready"])
        tracked.write_text("edited after baseline\n")
        (self.root / "new.txt").write_text("new untracked content\n")
        self.success("git", {"operation": "baseline"})
        result = self.success("git", {"operation": "diff"})
        self.assertIn("staged before baseline", result["diff"])
        self.assertIn("edited after baseline", result["diff"])
        self.assertIn("new untracked content", result["diff"])
        self.assertEqual({item["path"] for item in result["files"]}, {"tracked.txt", "new.txt"})
        for path, content in original.items():
            self.assertEqual(path.read_bytes(), content, str(path))
        self.assertEqual(git("diff", "--cached", "--no-ext-diff"), staged)
        self.assertFalse(hook_marker.exists())
        self.assertTrue((self.control / "projects" / self.workspace / ".workbench/baseline.git/HEAD").is_file())

    def test_git_rejects_a_symlinked_baseline_control_directory(self):
        self.success("prepare")
        workbench = self.control / "projects" / self.workspace / ".workbench"
        if workbench.exists():
            shutil.rmtree(workbench)
        outside = self.base / "outside"
        outside.mkdir()
        workbench.symlink_to(outside, target_is_directory=True)
        self.assert_rejected("git", {"operation": "baseline"})
        self.assertEqual(list(outside.iterdir()), [])

    def app_header(self, mode="code"):
        return {"mode": mode, "env": {
            "NEW_API_KEY": "fixture-model-token-never-real",
            "NEW_API_BASE_URL": "https://model.invalid/v1",
            "GH_TOKEN": "fixture-github-token-never-real",
            "GITHUB_TOKEN": "fixture-github-token-never-real",
            "GIT_CONFIG_COUNT": "1",
            "GIT_CONFIG_KEY_0": "credential.https://github.com.helper",
            "GIT_CONFIG_VALUE_0": "!gh auth git-credential",
        }}

    def test_app_server_consumes_only_header_and_forwards_all_rpc_lines(self):
        for mode in ["code", "ask"]:
            with self.subTest(mode=mode):
                header = self.app_header(mode)
                payload = "\n".join(json.dumps(value) for value in [
                    header, {"jsonrpc": "2.0", "id": 41, "method": "initialize"},
                    {"jsonrpc": "2.0", "id": 42, "method": "thread/start"},
                ]) + "\n"
                result = subprocess.run(self.command("app-server"), input=payload, capture_output=True,
                                        text=True, env=self.env, timeout=15)
                self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
                responses = [json.loads(line) for line in result.stdout.splitlines()]
                self.assertEqual([value.get("id") for value in responses], [41, 42], responses)
                child = responses[0]["result"]
                self.assertEqual(child["cwd"], str(self.root))
                self.assertIn("app-server", child["argv"])
                for key, value in header["env"].items():
                    self.assertEqual(child["env"].get(key), value, key)
                self.assertNotIn("REMOTE_TEST_PARENT_SECRET", child["env"])
                argv = " ".join(child["argv"])
                if mode == "ask":
                    self.assertIn('sandbox_mode="read-only"', argv)
                self.assertNotIn(header["env"]["NEW_API_KEY"], argv)
                self.assertNotIn(header["env"]["GH_TOKEN"], argv)
                for path in self.control.rglob("*"):
                    if path.is_file():
                        content = path.read_bytes()
                        self.assertNotIn(header["env"]["NEW_API_KEY"].encode(), content, str(path))
                        self.assertNotIn(header["env"]["GH_TOKEN"].encode(), content, str(path))

    def test_app_server_rejects_unapproved_environment_fields(self):
        for key in ["HOME", "CODEX_HOME", "PATH", "PYTHONPATH", "LD_PRELOAD", "GIT_SSH_COMMAND"]:
            with self.subTest(key=key):
                header = self.app_header()
                header["env"][key] = "fixture-forbidden-override"
                self.assert_rejected("app-server", header)

    def test_stop_terminates_the_running_app_server_and_its_child(self):
        process = subprocess.Popen(self.command("app-server"), stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, env=self.env)

        def cleanup():
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=5)

        self.addCleanup(cleanup)
        process.stdin.write(json.dumps(self.app_header()) + "\n")
        process.stdin.write(json.dumps({"jsonrpc": "2.0", "id": 51, "method": "hold"}) + "\n")
        process.stdin.flush()
        ready, _, _ = select.select([process.stdout], [], [], 10)
        self.assertTrue(ready, "App Server did not respond to the RPC fixture")
        line = process.stdout.readline()
        if not line:
            self.fail(f"App Server closed stdout before its first response (exit={process.poll()})")
        response = json.loads(line)
        self.assertEqual(response.get("id"), 51, response)
        child = response["result"]
        self.assert_private_tree()
        tmp_marker = Path("/tmp") / f"new-api-codex-process-{self.workspace}.json"
        self.assertFalse(tmp_marker.exists())
        stopped = self.success("stop")
        self.assertTrue(stopped["stopped"])
        process.communicate(timeout=5)
        for pid in [child["pid"], child["childPid"]]:
            proc_stat = Path(f"/proc/{pid}/stat")
            if proc_stat.exists():
                state = proc_stat.read_text().rsplit(")", 1)[1].split()[0]
                self.assertEqual(state, "Z", f"Managed process {pid} is still running")
        self.assertTrue(self.success("stop")["stopped"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
