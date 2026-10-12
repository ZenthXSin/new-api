#!/usr/bin/env python3
"""Remote project operations under the SSH account, with private control state."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit

UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
HELPERS = Path(__file__).resolve().parent
BASE_ENV = {"PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"), "LANG": "C.UTF-8"}
GIT_FLAGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.pager=cat", "-c", "credential.helper=", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "http.followRedirects=false", "-c", "user.name=New API Codex", "-c", "user.email=codex@localhost", "-c", "commit.gpgSign=false"]


def checked_directory(location, private=False, create=False):
    """Resolve every component without following project-controlled symlinks."""
    current = Path(location.anchor)
    for component in location.parts[1:]:
        current = current / component
        if create:
            try:
                current.mkdir(mode=0o700)
            except FileExistsError:
                pass
        info = current.lstat()
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise ValueError("Remote directory contains a symbolic link or is unavailable")
    if private:
        info = location.lstat()
        if info.st_uid != os.geteuid() or info.st_mode & 0o022:
            raise ValueError("Remote control directory has unsafe ownership or permissions")
        location.chmod(0o700)
    return location


def layout(root_value, workspace):
    if not UUID.fullmatch(workspace):
        raise ValueError("Invalid workspace identifier")
    if not root_value.startswith("/") or len(root_value) > 1024 or any(ord(c) < 32 for c in root_value) or "\\" in root_value or any(p in (".", "..") for p in root_value.split("/")):
        raise ValueError("Specify an absolute remote project directory")
    root = Path(root_value)
    home = Path.home()
    legacy_control = home / ".local/share/new-api-codex"
    control = legacy_control
    folders = [home / ".local", home / ".local/share"]
    if root == home:
        parent = Path(os.environ.get("NEW_API_CODEX_REMOTE_CONTROL_PARENT", "/var/tmp"))
        checked_directory(parent)
        control = parent / ("new-api-codex-" + str(os.geteuid()) + "-" + hashlib.sha256(str(home).encode()).hexdigest()[:16])
        folders = []
    if root == Path("/") or root == control or control in root.parents or root in control.parents or (root != home and (root == legacy_control or legacy_control in root.parents or root in legacy_control.parents)):
        raise ValueError("Choose a project directory outside the remote control directory")
    checked_directory(home)
    checked_directory(root)
    for folder in [*folders, control, control / "projects", control / "projects" / workspace]:
        checked_directory(folder, private=folder == control or control in folder.parents, create=True)
        info = folder.lstat()
        if info.st_uid != os.geteuid() or info.st_mode & 0o022:
            raise ValueError("Unsafe remote control parent")
    project_home = control / "projects" / workspace
    binding = project_home / "project.json"
    if binding.exists() or binding.is_symlink():
        info = binding.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise ValueError("Unsafe remote project binding")
        if json.loads(binding.read_text()).get("root") != str(root):
            raise ValueError("Remote project binding changed")
    else:
        with binding.open("x") as stream:
            json.dump({"root": str(root)}, stream)
    checked_directory(project_home / ".codex", private=True, create=True)
    return root, home, project_home


def bounded_command(argv, cwd, env, timeout=90, limit=2 * 1024 * 1024):
    with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
        child = subprocess.Popen(argv, cwd=cwd, env=env, stdout=output, stderr=errors, start_new_session=True)
        try:
            code = child.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
            raise ValueError("Remote operation timed out")
        output.seek(0)
        data = output.read(limit + 1)
        if code:
            # Git can echo provider credentials. Keep its raw errors private.
            raise ValueError("Remote Git operation failed; check repository access and project permissions")
    return data[:limit], len(data) > limit


def git_operation(root, home, project_home, request):
    workbench = checked_directory(project_home / ".workbench", private=True, create=True)
    baseline_dir = workbench / "baseline.git"
    if baseline_dir.exists() or baseline_dir.is_symlink():
        checked_directory(baseline_dir, private=True)
    env = {**BASE_ENV, "HOME": str(project_home), "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_TERMINAL_PROMPT": "0", "GIT_LFS_SKIP_SMUDGE": "1", "GIT_OPTIONAL_LOCKS": "0"}
    paths = ["."]
    if root == home:
        paths.append(":(exclude,literal).local/share/new-api-codex")

    def git(args, snapshot=True, extra=None, cwd=root):
        current_env = dict(env)
        if snapshot:
            current_env.update(GIT_DIR=str(baseline_dir), GIT_WORK_TREE=str(root))
        if extra:
            current_env.update(extra)
        return bounded_command(["git", *GIT_FLAGS, *args], cwd, current_env)

    def baseline():
        if (baseline_dir / "HEAD").exists():
            return
        git(["init", "--bare", "--initial-branch=main", str(baseline_dir)], snapshot=False)
        git(["add", "--all", "--", *paths])
        git(["commit", "--allow-empty", "-m", "Initial remote project snapshot"])

    operation = request.get("operation")
    if operation == "clone":
        if any(root.iterdir()):
            raise ValueError("Repository import requires an empty remote directory")
        url = urlsplit(request.get("url", ""))
        if url.scheme != "https" or url.username or url.password or url.query or url.fragment or url.port not in (None, 443) or url.hostname != request.get("hostname"):
            raise ValueError("Invalid repository URL")
        address = request["addresses"][0]
        if ":" in address:
            address = "[" + address + "]"
        branch = request.get("branch", "")
        if branch and (not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,199}", branch) or ".." in branch or "//" in branch or branch.endswith(("/", ".lock"))):
            raise ValueError("Invalid repository branch")
        credentials = validated_environment(request.get("env", {}), provider=False)
        with tempfile.TemporaryDirectory(dir=project_home, prefix="clone-") as temporary:
            destination = Path(temporary) / "repository"
            args = ["-c", f"http.curloptResolve={url.hostname}:443:{address}"]
            if url.hostname == "github.com" and credentials.get("GH_TOKEN"):
                args += ["-c", "credential.https://github.com.helper=" + credentials.get("GIT_CONFIG_VALUE_1", "")]
            else:
                credentials = {}
            args += ["clone", "--depth=1", "--no-recurse-submodules", "--template="]
            if branch:
                args += ["--branch", branch]
            git([*args, "--", request["url"], str(destination)], snapshot=False, extra=credentials)
            for entry in destination.iterdir():
                shutil.move(str(entry), str(root / entry.name))
        baseline()
        return {"imported": True, "repositoryUrl": request["url"]}
    baseline()
    if operation == "baseline":
        return {"ready": True}
    if operation != "diff":
        raise ValueError("Unknown remote Git operation")
    with tempfile.TemporaryDirectory(dir=project_home, prefix="diff-") as temporary:
        extra = {"GIT_INDEX_FILE": str(Path(temporary) / "index")}
        git(["read-tree", "HEAD"], extra=extra)
        git(["add", "--intent-to-add", "--all", "--", *paths], extra=extra)
        diff, truncated = git(["diff", "--no-ext-diff", "--no-textconv", "--no-color", "HEAD", "--", *paths], extra=extra)
        statuses, more = git(["diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "HEAD", "--", *paths], extra=extra)
    fields = statuses.decode(errors="replace").split("\0")
    files = []
    while len(fields) >= 2 and fields[0]:
        status_value, name = fields.pop(0), fields.pop(0)
        if status_value.startswith(("R", "C")) and fields:
            name = fields.pop(0)
        files.append({"path": name, "status": status_value})
    return {"diff": diff.decode(errors="replace"), "files": files[:5000], "truncated": truncated or more or len(files) > 5000}


def validated_environment(value, provider=True):
    allowed = {"NEW_API_KEY", "NEW_API_BASE_URL", "GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GH_PROMPT_DISABLED", "GH_BROWSER", "GIT_TERMINAL_PROMPT", "GIT_CONFIG_COUNT"}
    if not isinstance(value, dict) or len(value) > 32:
        raise ValueError("Invalid remote environment")
    for key, content in value.items():
        if key not in allowed and not re.fullmatch(r"GIT_CONFIG_(KEY|VALUE)_[0-3]", key):
            raise ValueError("Unapproved remote environment field")
        if not isinstance(content, str) or "\0" in content or len(content) > 16384:
            raise ValueError("Invalid remote environment value")
    count = value.get("GIT_CONFIG_COUNT", "0")
    if count not in ("0", "1", "2", "3", "4"):
        raise ValueError("Invalid Git credential configuration")
    for index in range(int(count)):
        name = value.get(f"GIT_CONFIG_KEY_{index}", "")
        if name not in ("credential.helper", "credential.https://github.com.helper", "credential.https://github.com.username", "http.https://github.com/.followRedirects"):
            raise ValueError("Unapproved Git configuration")
    if provider:
        url = urlsplit(value.get("NEW_API_BASE_URL", ""))
        if not value.get("NEW_API_KEY") or url.scheme not in ("https", "http") or not url.hostname or url.username or url.password or url.query or url.fragment:
            raise ValueError("Model provider is not configured")
    return value


def process_identity(pid):
    try:
        location = Path(f"/proc/{pid}")
        fields = (location / "stat").read_text().rsplit(")", 1)[1].split()
        return {"pid": int(pid), "session": int(fields[3]), "start": fields[19], "uid": location.stat().st_uid}
    except (OSError, ValueError, IndexError):
        return None


def stop_process(record, expected=None):
    if not record.exists():
        return
    info = record.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise ValueError("Unsafe remote process record")
    identity = json.loads(record.read_text())
    if expected and identity != expected:
        return
    current = process_identity(identity["pid"])
    if current and current != identity:
        raise ValueError("Remote process identity changed")
    # Never target another SSH user's process or a reused process session.
    for sig in (signal.SIGTERM, signal.SIGKILL):
        for entry in Path("/proc").iterdir():
            if not entry.name.isdigit():
                continue
            child = process_identity(entry.name)
            if child and child["uid"] == os.geteuid() and child["session"] == identity["session"] and child["pid"] != os.getpid():
                try:
                    os.kill(child["pid"], sig)
                except ProcessLookupError:
                    pass
        if sig == signal.SIGTERM:
            time.sleep(0.15)
    record.unlink(missing_ok=True)


def process_record(project_home, process_id=None):
    if process_id is None:
        return project_home / "process.json"
    if not isinstance(process_id, str) or not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", process_id):
        raise ValueError("Invalid conversation process identity")
    return project_home / ("process-" + process_id + ".json")


def app_server(root, home, project_home, header):
    mode = header.get("mode")
    if mode not in ("code", "ask"):
        raise ValueError("Invalid remote development mode")
    provider_env = validated_environment(header.get("env"))
    bundled = HELPERS / "bin/codex"
    codex = str(bundled) if bundled.is_file() else shutil.which("codex")
    if not codex:
        raise ValueError("Codex CLI is unavailable on this remote server")
    env = {**BASE_ENV, "HOME": str(home), "CODEX_HOME": str(project_home / ".codex"), **provider_env}
    if bundled.is_file():
        env["PATH"] = str(HELPERS / "bin") + ":" + env["PATH"]
    provider = '{name="New API",base_url=' + json.dumps(provider_env["NEW_API_BASE_URL"].rstrip("/")) + ',env_key="NEW_API_KEY",wire_api="responses",request_max_retries=2,stream_max_retries=2}'
    argv = [codex, "-c", 'model_provider="newapi"', "-c", "model_providers.newapi=" + provider,
            "-c", 'sandbox_mode="read-only"' if mode == "ask" else 'sandbox_mode="danger-full-access"',
            "-c", 'approval_policy="on-request"', "-c", "analytics.enabled=false", "-c", "check_for_update_on_startup=false", "app-server", "--listen", "stdio://"]
    record = process_record(project_home, header.get("processId"))
    stop_process(record)
    child = subprocess.Popen(argv, cwd=root, env=env, start_new_session=True)
    identity = process_identity(child.pid)
    if identity:
        with record.open("x") as stream:
            json.dump(identity, stream)
    def stop(*_):
        stop_process(record, identity)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGHUP, stop)
    try:
        return child.wait()
    finally:
        stop_process(record, identity)


def main():
    os.umask(0o077)
    operation, root_value, workspace = sys.argv[1:4]
    root, home, project_home = layout(root_value, workspace)
    if operation == "app-server":
        # Read bytewise: buffered readline can swallow the first RPC message.
        header = bytearray()
        while True:
            value = os.read(0, 1)
            if value == b"\n" or not value:
                break
            if len(header) >= 262144:
                raise ValueError("Remote process header exceeds the size limit")
            header.extend(value)
        return app_server(root, home, project_home, json.loads(header))
    payload = sys.stdin.read()
    request = json.loads(payload) if payload.strip() else {}
    if operation == "prepare":
        result = {"root": str(root), "home": str(project_home), "capabilities": {"files": True, "appServer": True}}
    elif operation == "file":
        env = {**BASE_ENV, "HOME": str(home), "NEW_API_CODEX_REMOTE": "1"}
        if root == home:
            env["NEW_API_CODEX_REMOTE_EXCLUDED_PATHS"] = json.dumps([".local/share/new-api-codex"])
        if request.get("operation") == "download":
            # Preserve raw bytes and backpressure across SSH instead of buffering
            # the artifact into a JSON/base64 response.
            process = subprocess.Popen([sys.executable, "-I", str(HELPERS / "safe-files.py"), str(root)], stdin=subprocess.PIPE, env=env)
            process.communicate(json.dumps(request).encode(), timeout=300)
            return process.returncode
        process = subprocess.run([sys.executable, "-I", str(HELPERS / "safe-files.py"), str(root)], input=json.dumps(request), capture_output=True, text=True, env=env, timeout=100)
        value = json.loads(process.stdout)
        print(json.dumps(value))
        return 0 if value.get("ok") else 1
    elif operation == "git":
        result = git_operation(root, home, project_home, request)
    elif operation == "stop":
        stop_process(process_record(project_home, request.get("processId")))
        result = {"stopped": True}
    else:
        raise ValueError("Unknown remote workspace operation")
    print(json.dumps({"ok": True, "result": result}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, TypeError, IndexError, subprocess.TimeoutExpired):
        print(json.dumps({"ok": False, "error": "Remote project path or operation is unavailable; check the connection and directory permissions", "code": "remote_operation_failed", "statusCode": 409}))
        raise SystemExit(1)
