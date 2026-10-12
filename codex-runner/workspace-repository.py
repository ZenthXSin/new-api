"""Offline repository metadata and non-forcing branch selection in one workspace."""
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit, urlunsplit


class RepositoryError(Exception):
    def __init__(self, message, code="repository_failed", status=409):
        super().__init__(message)
        self.code = code
        self.status = status


ENV = {
    "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
    "HOME": "/nonexistent", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_TERMINAL_PROMPT": "0", "GIT_OPTIONAL_LOCKS": "0", "GIT_ALLOW_PROTOCOL": "",
    "GIT_PROTOCOL_FROM_USER": "0", "GIT_NO_LAZY_FETCH": "1", "GIT_LFS_SKIP_SMUDGE": "1",
}
FLAGS = [
    "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    "-c", "core.untrackedCache=false", "-c", "core.pager=cat",
    "-c", "credential.helper=", "-c", "protocol.allow=never",
    "-c", "submodule.recurse=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0",
]


def git(root, args, allow_failure=False):
    with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
        env = {**ENV, "GIT_CEILING_DIRECTORIES": str(Path(root).parent)}
        process = subprocess.Popen(["git", *FLAGS, *args], cwd=root, env=env, stdout=output, stderr=errors)
        try:
            code = process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
            raise RepositoryError("Repository operation timed out", "repository_timeout", 504)
        output.seek(0)
        content = output.read(2 * 1024 * 1024 + 1)
    if len(content) > 2 * 1024 * 1024:
        raise RepositoryError("Repository metadata exceeds the supported size", "repository_too_large", 413)
    if code and not allow_failure:
        # Git diagnostics can contain URLs, host paths, or repository secrets.
        raise RepositoryError("Git could not complete this repository operation")
    return code, content.decode("utf-8", errors="replace")


def checked_root(value):
    if not isinstance(value, str) or not value.startswith("/") or value == "/" or any(x in value for x in ["\0", "\n", "\r", "\\"]):
        raise RepositoryError("Invalid project directory", "unsafe_repository", 400)
    root = Path(value)
    if str(root) != value or any(part in (".", "..") for part in root.parts):
        raise RepositoryError("Project directory must be canonical", "unsafe_repository", 400)
    current = Path(root.anchor)
    for part in root.parts[1:]:
        current = current / part
        info = current.lstat()
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise RepositoryError("Project directory contains an unsafe link", "unsafe_repository", 400)
    return root


def check_git_directory(root):
    directory = root / ".git"
    if not directory.exists() and not directory.is_symlink():
        return False
    if directory.is_symlink() or not directory.is_dir():
        raise RepositoryError("Linked Git directories and worktrees are not supported by branch selection", "unsupported_repository")
    count = 0
    for parent, directories, files in os.walk(directory, followlinks=False):
        for name in directories + files:
            location = Path(parent) / name
            info = location.lstat()
            count += 1
            if count > 100000:
                raise RepositoryError("Repository metadata exceeds the supported size", "repository_too_large", 413)
            if stat.S_ISLNK(info.st_mode) or not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)) or stat.S_ISREG(info.st_mode) and info.st_nlink > 1:
                raise RepositoryError("Git metadata contains an unsafe link or special file", "unsafe_repository", 400)
    for relative in ["commondir", "objects/info/alternates", "objects/info/http-alternates"]:
        if (directory / relative).exists():
            raise RepositoryError("External Git object directories are not supported", "unsupported_repository")
    if any((directory / "objects" / "pack").glob("*.promisor")):
        raise RepositoryError("Partial clones require fetching before branch selection", "unsupported_repository")
    return True


def safe_url(value):
    if not isinstance(value, str) or len(value) > 4096 or any(ord(char) < 32 or ord(char) == 127 for char in value):
        return None
    try:
        parsed = urlsplit(value)
        if parsed.scheme in ("https", "http", "ssh", "git") and parsed.hostname:
            host = parsed.hostname
            if ":" in host:
                host = "[" + host + "]"
            if parsed.port:
                host += ":" + str(parsed.port)
            return urlunsplit((parsed.scheme, host, parsed.path, "", ""))
        match = re.fullmatch(r"(?:[^@/:]+@)?([A-Za-z0-9._-]+):([^?#]+)(?:[?#].*)?", value)
        if match and not re.match(r"^[A-Za-z]:[/\\]", value):
            return "ssh://" + match.group(1) + "/" + match.group(2).lstrip("/")
    except ValueError:
        pass
    return None


def repository_config(root):
    # Git may load the discovered repository before parsing --no-includes.
    # Read the validated config from a neutral directory with no discovery.
    with tempfile.TemporaryDirectory(prefix="codex-repository-config-") as neutral:
        _, output = git(neutral, ["config", "--file", str(root / ".git/config"), "--no-includes", "--null", "--list"])
    config = []
    for entry in output.split("\0"):
        if not entry:
            continue
        key, separator, value = entry.partition("\n")
        normalized = key.lower()
        if normalized.startswith(("include.", "includeif.", "filter.")) or normalized in ("core.worktree", "extensions.worktreeconfig", "extensions.partialclone") or normalized.endswith((".promisor", ".partialclonefilter")):
            raise RepositoryError("Repositories with external configuration, filters, or partial-clone dependencies require Git operations in the project terminal", "unsupported_repository")
        if normalized == "core.bare" and value.lower() == "true":
            raise RepositoryError("Bare repositories do not have a project working tree", "unsupported_repository")
        config.append((key, value if separator else "true"))
    return config


def validate_branch(root, value):
    if not isinstance(value, str) or not value or len(value) > 200 or value.startswith(("-", "refs/")) or value == "HEAD" or "@{" in value or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise RepositoryError("Invalid repository branch", "invalid_branch", 400)
    code, _ = git(root, ["check-ref-format", "refs/heads/" + value], allow_failure=True)
    if code:
        raise RepositoryError("Invalid repository branch", "invalid_branch", 400)
    return value


def metadata(root, config):
    branch_code, branch = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], allow_failure=True)
    head_code, head = git(root, ["rev-parse", "--verify", "HEAD^{commit}"], allow_failure=True)
    _, status = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=all"])
    _, listed = git(root, ["for-each-ref", "--format=%(refname)%00%(symref)", "refs/heads/", "refs/remotes/"])
    _, index = git(root, ["ls-files", "--stage", "-z"])
    has_submodules = any(entry.startswith("160000 ") for entry in index.split("\0"))
    remotes = []
    for key, value in config:
        if key.startswith("remote.") and key.endswith(".url"):
            name = key[len("remote."):-len(".url")]
            if not any(remote["name"] == name for remote in remotes):
                remotes.append({"name": name, "url": safe_url(value)})
    branches = []
    for entry in listed.splitlines():
        ref, _, symbolic = entry.partition("\0")
        if symbolic:
            continue
        remote = None
        if ref.startswith("refs/heads/"):
            name = ref[len("refs/heads/"):]
        elif ref.startswith("refs/remotes/"):
            rest = ref[len("refs/remotes/"):]
            matches = [item["name"] for item in remotes if rest.startswith(item["name"] + "/")]
            remote = max(matches, key=len) if matches else rest.partition("/")[0]
            name = rest[len(remote) + 1:]
            if not name:
                continue
        else:
            continue
        branches.append({"name": name, "ref": ref, "remote": remote, "current": remote is None and not branch_code and name == branch.strip()})
    in_progress = any((root / ".git" / name).exists() for name in ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "BISECT_LOG"])
    return {
        "available": True, "branch": branch.strip() if not branch_code else None,
        "head": head.strip() if not head_code else None, "detached": bool(branch_code) and not head_code,
        "dirty": bool(status), "remotes": remotes, "branches": branches[:1000],
        "branchesTruncated": len(branches) > 1000, "hasSubmodules": has_submodules,
        "checkoutSupported": not has_submodules and not in_progress,
        "checkoutReason": "submodules" if has_submodules else "operation_in_progress" if in_progress else None,
    }


def run(request):
    root = checked_root(request.get("cwd"))
    operation = request.get("operation")
    if operation not in ("metadata", "checkout"):
        raise RepositoryError("Unknown repository operation", "invalid_repository_operation", 400)
    if not check_git_directory(root):
        if operation == "checkout":
            raise RepositoryError("This project is not a Git repository", "repository_not_found", 404)
        return {"available": False, "branch": None, "head": None, "detached": False, "dirty": False, "remotes": [], "branches": [], "branchesTruncated": False, "hasSubmodules": False, "checkoutSupported": False, "checkoutReason": "not_repository"}
    config = repository_config(root)
    result = metadata(root, config)
    if operation == "metadata":
        return result
    branch = validate_branch(root, request.get("branch"))
    remote = request.get("remote")
    if remote is not None and (not isinstance(remote, str) or not remote or len(remote) > 200 or remote.startswith("-") or any(ord(char) < 33 or ord(char) == 127 for char in remote)):
        raise RepositoryError("Invalid repository remote", "invalid_remote", 400)
    if result["dirty"]:
        raise RepositoryError("Commit or discard project changes before switching branches", "repository_dirty")
    if not result["checkoutSupported"]:
        raise RepositoryError("Finish the active Git operation or switch submodule branches in the project terminal", "checkout_unsupported")
    ref = "refs/remotes/" + remote + "/" + branch if remote else "refs/heads/" + branch
    code, _ = git(root, ["show-ref", "--verify", "--quiet", ref], allow_failure=True)
    if code:
        raise RepositoryError("Branch was not found in this project. Fetch it in the project terminal first.", "branch_not_found", 404)
    args = ["switch", "--no-overwrite-ignore", "--no-recurse-submodules", "--no-guess"]
    if remote:
        if remote not in [entry["name"] for entry in result["remotes"]]:
            raise RepositoryError("Repository remote was not found", "remote_not_found", 404)
        exists, _ = git(root, ["show-ref", "--verify", "--quiet", "refs/heads/" + branch], allow_failure=True)
        if not exists:
            raise RepositoryError("A local branch with this name already exists. Select that local branch.", "branch_exists")
        args += ["--track", "-c", branch, "--", ref]
    else:
        args += ["--", branch]
    code, _ = git(root, args, allow_failure=True)
    if code:
        raise RepositoryError("Branch could not be switched safely. Check ignored files, worktrees, or Git locks in the project terminal.", "checkout_conflict")
    return metadata(root, repository_config(root))


try:
    payload = json.load(sys.stdin)
    if not isinstance(payload, dict):
        raise RepositoryError("Invalid repository request", "invalid_repository_request", 400)
    print(json.dumps({"ok": True, "result": run(payload)}))
except RepositoryError as error:
    print(json.dumps({"ok": False, "error": str(error), "code": error.code, "statusCode": error.status}))
    sys.exit(1)
except (OSError, ValueError, TypeError, KeyError):
    print(json.dumps({"ok": False, "error": "Repository is unavailable or its metadata is invalid", "code": "repository_failed", "statusCode": 409}))
    sys.exit(1)
