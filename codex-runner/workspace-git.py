#!/usr/bin/env python3
"""Runs only inside a non-root workspace container; no shell or project hooks."""
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(os.environ["NEW_API_CODEX_PROJECT_DIR"])
PROJECT_HOME = pathlib.Path(os.environ["NEW_API_CODEX_PROJECT_HOME"])
BASELINE = PROJECT_HOME / ".workbench/baseline.git"
if not ROOT.is_absolute() or not str(ROOT).startswith("/workspace/projects/") or not str(PROJECT_HOME).startswith("/home/codex/workspaces/"):
    raise ValueError("Invalid managed project paths")
ENV = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/tmp", "LANG": "C.UTF-8", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_TERMINAL_PROMPT": "0", "GIT_LFS_SKIP_SMUDGE": "1", "GIT_OPTIONAL_LOCKS": "0"}
FLAGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.pager=cat", "-c", "credential.helper=", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "http.followRedirects=false", "-c", "user.name=New API Codex", "-c", "user.email=codex@localhost", "-c", "commit.gpgSign=false"]


def git(arguments, cwd=ROOT, baseline=True, limit=2 * 1024 * 1024, timeout=90, extra_env=None):
    env = dict(ENV)
    if baseline:
        env.update({"GIT_DIR": str(BASELINE), "GIT_WORK_TREE": str(ROOT)})
    if extra_env:
        env.update(extra_env)
    with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
        command = subprocess.Popen(["git", *FLAGS, *arguments], cwd=cwd, env=env, stdout=output, stderr=errors)
        try:
            code = command.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            command.kill()
            command.wait()
            raise ValueError("Git operation timed out")
        output.seek(0)
        data = output.read(limit + 1)
        errors.seek(0)
        error = errors.read(4096).decode(errors="replace")
    if code:
        # Details may contain a remote URL, but credentials and query parameters are rejected before this process starts.
        raise ValueError(error.strip() or "Git operation failed")
    return data[:limit], len(data) > limit


def baseline():
    if (BASELINE / "HEAD").exists():
        return
    BASELINE.parent.mkdir(parents=True, exist_ok=True)
    git(["init", "--bare", "--initial-branch=main", str(BASELINE)], baseline=False)
    git(["add", "--all", "--", "."])
    git(["commit", "--allow-empty", "-m", "Initial workspace snapshot"])


def run(request):
    operation = request["operation"]
    if operation == "baseline":
        baseline()
        return {"ready": True}
    if operation == "diff":
        baseline()
        # A temporary index includes untracked files without modifying the user's repository or staging area.
        with tempfile.TemporaryDirectory(prefix="codex-diff-") as directory:
            index = pathlib.Path(directory) / "index"
            env = {"GIT_INDEX_FILE": str(index)}
            git(["read-tree", "HEAD"], extra_env=env)
            git(["add", "--intent-to-add", "--all", "--", "."], extra_env=env)
            diff, truncated = git(["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "HEAD", "--", "."], extra_env=env)
            statuses, more = git(["diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "HEAD", "--", "."], extra_env=env)
        fields = statuses.decode("utf-8", errors="replace").split("\0")
        files = []
        while len(fields) >= 2 and fields[0]:
            status = fields.pop(0)
            name = fields.pop(0)
            if status.startswith(("R", "C")) and fields:
                name = fields.pop(0)
            files.append({"path": name, "status": status})
        return {"diff": diff.decode("utf-8", errors="replace"), "files": files[:5000], "truncated": truncated or more or len(files) > 5000}
    if operation == "clone":
        if any(ROOT.iterdir()):
            raise ValueError("Repository import requires an empty workspace")
        host, address = request["hostname"], request["addresses"][0]
        if ":" in address:
            address = "[" + address + "]"
        with tempfile.TemporaryDirectory(prefix="codex-clone-", dir=PROJECT_HOME) as directory:
            destination = pathlib.Path(directory) / "project"
            branch = ["--branch", request["branch"]] if request.get("branch") else []
            git(["-c", f"http.curloptResolve={host}:443:{address}", "clone", "--depth=1", "--no-recurse-submodules", "--template=", *branch, "--", request["url"], str(destination)], cwd="/tmp", baseline=False, timeout=100)
            # New workspaces have no pre-existing files. Never merge a failed/partial clone.
            for item in destination.iterdir():
                shutil.move(str(item), str(ROOT / item.name))
        baseline()
        return {"imported": True, "repositoryUrl": request["url"]}
    raise ValueError("Unknown Git operation")


try:
    print(json.dumps({"ok": True, "result": run(json.load(sys.stdin))}))
except (ValueError, OSError, KeyError, TypeError) as error:
    print(json.dumps({"ok": False, "error": str(error)[:4096]}))
    sys.exit(1)
