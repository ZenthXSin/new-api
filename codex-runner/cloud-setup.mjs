import { validateCloneUrl } from './workspace-files.mjs';
import { apiError } from './store.mjs';

const OUTPUT_LIMIT = 128 * 1024;

// Executed inside the workspace runtime. Repository inputs arrive over stdin;
// only the user's explicit install script is interpreted by a shell.
const SETUP_HELPER = String.raw`
import ctypes
import errno
import ipaddress
import json
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit

LIMIT = 128 * 1024
GIT_ENV = {
    "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
    "HOME": "/nonexistent", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_TERMINAL_PROMPT": "0", "GIT_OPTIONAL_LOCKS": "0", "GIT_LFS_SKIP_SMUDGE": "1",
    "GIT_PROTOCOL_FROM_USER": "0", "GIT_NO_LAZY_FETCH": "1", "GIT_ALLOW_PROTOCOL": "https",
}
GIT_FLAGS = [
    "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.pager=cat",
    "-c", "credential.helper=", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always",
    "-c", "http.followRedirects=false", "-c", "http.sslVerify=true", "-c", "http.proxy=",
    "-c", "submodule.recurse=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0",
]
# This is fixed application code, never a helper supplied by a repository.
GITHUB_HELPER = '!f() { [ "$1" = get ] || return 0; p=; h=; while IFS== read -r k v; do case "$k" in protocol) p="$v" ;; host) h="$v" ;; esac; done; [ "$p" = https ] || return 0; case "$h" in github.com|github.com:443) [ -n "$GH_TOKEN" ] && printf "username=x-access-token\\npassword=%s\\n" "$GH_TOKEN" ;; esac; }; f'


class SetupError(Exception):
    def __init__(self, message, code="cloud_setup_failed", status=409, output=None):
        super().__init__(message)
        self.code, self.status, self.output = code, status, output


def checked_directory(value):
    if not isinstance(value, str) or not value.startswith("/") or value == "/" or any(x in value for x in ["\0", "\n", "\r", "\\"]):
        raise SetupError("Invalid cloud workspace directory", "unsafe_cloud_workspace", 400)
    directory = Path(value)
    if str(directory) != value or ".." in directory.parts:
        raise SetupError("Invalid cloud workspace directory", "unsafe_cloud_workspace", 400)
    current = Path(directory.anchor)
    for part in directory.parts[1:]:
        current /= part
        if not stat.S_ISDIR(current.lstat().st_mode):
            raise SetupError("Cloud workspace contains an unsafe directory", "unsafe_cloud_workspace", 400)
    return directory


def run_bounded(argv, cwd, env, deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise SetupError("Cloud environment setup timed out", "cloud_setup_timeout", 504)
    process = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    output, truncated = bytearray(), False
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise SetupError("Cloud environment setup timed out", "cloud_setup_timeout", 504,
                                     output.decode("utf-8", errors="replace"))
                for key, _ in selector.select(min(remaining, 0.1)):
                    chunk = os.read(key.fileobj.fileno(), 65536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    room = max(0, LIMIT - len(output))
                    output.extend(chunk[:room])
                    truncated = truncated or len(chunk) > room
        process.wait(timeout=max(0.001, deadline - time.monotonic()))
    except (SetupError, subprocess.TimeoutExpired):
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()
        raise SetupError("Cloud environment setup timed out", "cloud_setup_timeout", 504,
                         output.decode("utf-8", errors="replace"))
    finally:
        process.stdout.close()
    return process.returncode, output.decode("utf-8", errors="replace"), truncated


def git(root, args, deadline, env=None, allow_failure=False):
    code, output, truncated = run_bounded(["git", *GIT_FLAGS, *args], root,
                                         {**GIT_ENV, **(env or {})}, deadline)
    if truncated or code and not allow_failure:
        # Even server-generated Git errors can contain credentials or secret URLs.
        raise SetupError("Git could not prepare the cloud repository", "cloud_clone_failed", 409)
    return code, output


def existing_repository(root, repository, deadline):
    directory = root / ".git"
    if not directory.exists() and not directory.is_symlink():
        if any(root.iterdir()):
            raise SetupError("Repository destination contains existing files; use a new environment", "cloud_repository_conflict")
        return None
    if not stat.S_ISDIR(directory.lstat().st_mode):
        raise SetupError("Linked Git workspaces require a new cloud environment", "cloud_repository_conflict")
    count = 0
    for parent, directories, files in os.walk(directory, followlinks=False):
        for name in directories + files:
            info = (Path(parent) / name).lstat()
            count += 1
            if count > 100000:
                raise SetupError("Repository metadata exceeds the supported size", "cloud_repository_too_large", 413)
            if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)) or stat.S_ISREG(info.st_mode) and info.st_nlink > 1:
                raise SetupError("Repository metadata contains unsafe links", "unsafe_cloud_workspace", 400)
    for relative in ["commondir", "objects/info/alternates", "objects/info/http-alternates"]:
        if (directory / relative).exists():
            raise SetupError("External Git directories require a new cloud environment", "cloud_repository_conflict")
    # Inspect config without repository discovery or includes before Git opens it.
    with tempfile.TemporaryDirectory(prefix="codex-cloud-config-") as neutral:
        _, output = git(neutral, ["config", "--file", str(directory / "config"), "--no-includes", "--null", "--list"], deadline)
    remotes = []
    for entry in output.split("\0"):
        if not entry:
            continue
        key, _, value = entry.partition("\n")
        key = key.lower()
        if key.startswith(("include.", "includeif.", "filter.")) or key in ("core.worktree", "extensions.worktreeconfig", "extensions.partialclone") or key.endswith((".promisor", ".partialclonefilter")):
            raise SetupError("External Git configuration requires a new cloud environment", "cloud_repository_conflict")
        if key == "remote.origin.url":
            remotes.append(value)
    if remotes != [repository["url"]]:
        raise SetupError("Repository URL differs from the existing checkout; use a new environment", "cloud_repository_conflict")
    branch_code, branch = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], deadline, allow_failure=True)
    commit_code, commit = git(root, ["rev-parse", "--verify", "HEAD^{commit}"], deadline, allow_failure=True)
    branch = branch.strip() if not branch_code else ""
    if repository.get("branch") and branch != repository["branch"]:
        raise SetupError("Repository branch differs from the existing checkout; use a new environment", "cloud_repository_conflict")
    if not commit_code and not re.fullmatch(r"[a-f0-9]{40,64}", commit.strip()):
        raise SetupError("Repository returned invalid commit metadata", "cloud_clone_failed")
    return {"url": repository["url"], "path": repository["path"], "branch": branch, "commit": None if commit_code else commit.strip()}


def move_without_overwrite(source, destination):
    # Both paths are inside the workspace filesystem; never replace a file that
    # appeared while a clone was in flight. Linux is required by the runtime.
    libc = ctypes.CDLL(None, use_errno=True)
    result = libc.renameat2(-100, os.fsencode(source), -100, os.fsencode(destination), 1)
    if result:
        error = ctypes.get_errno()
        if error in (errno.EEXIST, errno.ENOTEMPTY):
            raise SetupError("Repository destination changed during setup; existing files were preserved", "cloud_repository_conflict")
        raise OSError(error, "Repository files could not be installed")


def prepare_repositories(root, repositories, deadline):
    existing = []
    # Validate every destination before creating any repository.
    for repository in repositories:
        relative = repository["path"]
        if relative != "." and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}", relative):
            raise SetupError("Invalid repository directory", "invalid_cloud_repository", 400)
        destination = root if relative == "." else root / relative
        if destination.exists() or destination.is_symlink():
            destination = checked_directory(str(destination))
            existing.append(existing_repository(destination, repository, deadline))
        else:
            existing.append(None)
    prepared = []
    for repository, metadata in zip(repositories, existing):
        if metadata is not None:
            prepared.append(metadata)
            continue
        host, addresses = repository["hostname"], repository["addresses"]
        url = urlsplit(repository["url"])
        if url.scheme != "https" or url.hostname != host or url.username or url.password or url.query or url.fragment or url.port not in (None, 443):
            raise SetupError("Invalid repository URL", "invalid_cloud_repository", 400)
        if not addresses or any(not ipaddress.ip_address(address).is_global for address in addresses):
            raise SetupError("Repository addresses must be public", "invalid_cloud_repository", 400)
        resolve = host + ":443:" + ",".join("[" + address + "]" if ":" in address else address for address in addresses)
        branch = repository.get("branch", "")
        if branch:
            code, _ = git(root, ["check-ref-format", "--branch", branch], deadline, allow_failure=True)
            if code:
                raise SetupError("Invalid repository branch", "invalid_cloud_repository", 400)
        credential_flags, credential_env = [], {}
        if host == "github.com" and os.environ.get("GH_TOKEN"):
            credential_flags = ["-c", "credential.https://github.com.helper=" + GITHUB_HELPER]
            credential_env = {"GH_TOKEN": os.environ["GH_TOKEN"]}
        # Staging on the project filesystem lets promotion avoid cross-device
        # copies and leaves the destination untouched if the network clone fails.
        with tempfile.TemporaryDirectory(prefix=".codex-cloud-clone-", dir=root) as staging:
            checkout = Path(staging) / "checkout"
            args = [*credential_flags, "-c", "http.curloptResolve=" + resolve, "clone", "--depth=1", "--no-recurse-submodules", "--template="]
            if branch:
                args += ["--branch", branch]
            git(staging, [*args, "--", repository["url"], str(checkout)], deadline, env=credential_env)
            metadata = existing_repository(checkout, repository, deadline)
            destination = root if repository["path"] == "." else root / repository["path"]
            if destination == root:
                children = list(checkout.iterdir())
                if any((root / child.name).exists() or (root / child.name).is_symlink() for child in children):
                    raise SetupError("Repository destination changed during setup; existing files were preserved", "cloud_repository_conflict")
                # Publish .git last, so an interrupted promotion cannot look like
                # a completed checkout and silently hide a partial file transfer.
                for child in sorted(children, key=lambda entry: entry.name == ".git"):
                    move_without_overwrite(child, root / child.name)
            else:
                if destination.exists():
                    checked_directory(str(destination))
                    if any(destination.iterdir()):
                        raise SetupError("Repository destination changed during setup; existing files were preserved", "cloud_repository_conflict")
                    destination.rmdir()
                move_without_overwrite(checkout, destination)
            prepared.append(metadata)
    return {"repositories": prepared}


def run(request):
    root = checked_directory(request["cwd"])
    deadline = time.monotonic() + request["timeoutSeconds"]
    if request["operation"] == "repositories":
        return prepare_repositories(root, request["repositories"], deadline)
    if request["operation"] == "install":
        environment = dict(os.environ)
        for name in list(environment):
            if name in ("GH_TOKEN", "GITHUB_TOKEN", "BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS") or name.startswith("GIT_CONFIG_"):
                environment.pop(name, None)
        code, output, truncated = run_bounded(["/bin/bash", "-euo", "pipefail", "-c", request["script"]], root, environment, deadline)
        if truncated:
            output = output[:LIMIT - 40] + "\n[setup output truncated]\n"
        if code:
            raise SetupError("Cloud install script failed (exit " + str(code) + ")", "cloud_install_failed", 422, output)
        return {"output": output}
    raise SetupError("Unknown cloud setup operation", "invalid_cloud_setup", 400)


try:
    print(json.dumps({"ok": True, "result": run(json.load(sys.stdin))}))
except SetupError as error:
    response = {"ok": False, "error": str(error), "code": error.code, "statusCode": error.status}
    if error.output is not None:
        response["output"] = error.output
    print(json.dumps(response))
    sys.exit(1)
except (OSError, ValueError, KeyError, TypeError, AttributeError):
    print(json.dumps({"ok": False, "error": "Cloud environment setup could not be completed", "code": "cloud_setup_failed", "statusCode": 409}))
    sys.exit(1)
`;

function normalizeRepositories(repositories) {
  if (!Array.isArray(repositories) || repositories.length > 20) throw apiError(400, 'invalid_cloud_repository', 'Choose at most 20 cloud repositories');
  const paths = new Set();
  return repositories.map((repository) => {
    if (!repository || typeof repository !== 'object' || typeof repository.url !== 'string') throw apiError(400, 'invalid_cloud_repository', 'Invalid cloud repository');
    const branch = repository.branch || '', path = repository.path ?? (repositories.length === 1 ? '.' : '');
    if (typeof branch !== 'string' || branch && (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch) || branch === 'HEAD' || branch.startsWith('refs/') || branch.includes('..') || branch.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock')))) throw apiError(400, 'invalid_cloud_repository', 'Invalid cloud repository branch');
    if (typeof path !== 'string' || !(path === '.' && repositories.length === 1 || /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(path)) || paths.has(path)) throw apiError(400, 'invalid_cloud_repository', 'Choose a unique directory for each cloud repository');
    paths.add(path);
    let url; try { url = new URL(repository.url).href; } catch { throw apiError(400, 'invalid_cloud_repository', 'Invalid cloud repository URL'); }
    return { url, branch, path };
  });
}

/** Prepare real repository checkouts and run the configured install command. */
export async function prepareCloudWorkspace({ runtime, workspaceId, repositories = [], previousRepositories = [], installScript = '', workspaceEnvironment, githubEnvironment = {}, timeoutSeconds = 900, onStep }) {
  const desired = normalizeRepositories(repositories), previous = normalizeRepositories(previousRepositories);
  if (previous.some((entry) => !desired.some((next) => next.path === entry.path && next.url === entry.url && next.branch === entry.branch))) {
    throw apiError(409, 'cloud_repository_conflict', 'Removing, moving, or changing a prepared repository requires a new environment; existing files are preserved');
  }
  if (typeof installScript !== 'string' || Buffer.byteLength(installScript) > 128 * 1024 || installScript.includes('\0')) throw apiError(400, 'invalid_cloud_setup', 'Invalid cloud install script');
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) throw apiError(400, 'invalid_cloud_setup', 'Cloud setup timeout must be between 1 and 3600 seconds');
  // Resolve all hosts before the first mutation. The exact approved addresses
  // are passed to Git's curl resolver, with redirects and proxy use disabled.
  const approved = await Promise.all(desired.map(async (repository) => ({ ...repository, ...await validateCloneUrl(repository.url) })));
  const backend = runtime.backend?.(workspaceId) || runtime;
  if (typeof backend.exec !== 'function') throw apiError(503, 'cloud_setup_unavailable', 'Cloud setup is unavailable in this environment');
  const deadline = Date.now() + timeoutSeconds * 1000;
  const secrets = [...new Set([githubEnvironment.GH_TOKEN, githubEnvironment.GITHUB_TOKEN].filter((value) => typeof value === 'string' && value))];
  const sanitize = (value) => {
    let output = String(value || '');
    for (const secret of secrets) output = output.split(secret).join('[REDACTED]');
    return Buffer.from(output).subarray(0, OUTPUT_LIMIT).toString('utf8');
  };
  const execute = async (operation, request) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw apiError(504, 'cloud_setup_timeout', 'Cloud environment setup timed out');
    let result;
    try {
      result = await backend.exec(workspaceId, ['python3', '-I', '-c', SETUP_HELPER], {
        input: JSON.stringify({ operation, cwd: runtime.cwd(workspaceId), timeoutSeconds: remaining / 1000, ...request }),
        workspaceEnvironment, env: operation === 'repositories' ? githubEnvironment : {}, timeoutMs: remaining + 1000, maxBytes: 2 * 1024 * 1024,
      });
    } catch (error) {
      if (['operation_timeout', 'cloud_setup_timeout'].includes(error.code)) throw apiError(504, 'cloud_setup_timeout', 'Cloud environment setup timed out');
      throw apiError(503, 'cloud_setup_unavailable', 'Cloud setup runtime could not complete the operation');
    }
    let response; try { response = JSON.parse(result.stdout); } catch { throw apiError(502, 'cloud_setup_failed', 'Cloud setup returned an invalid result'); }
    if (!response.ok || result.code) {
      const error = apiError(response.statusCode || 409, response.code || 'cloud_setup_failed', sanitize(response.error || 'Cloud environment setup failed'));
      // Clone diagnostics are deliberately omitted; only the install script's
      // own output is useful here. The caller additionally redacts config secrets.
      if (operation === 'install' && response.output) error.output = sanitize(response.output);
      throw error;
    }
    return response.result;
  };
  let prepared = [];
  if (approved.length) {
    await onStep?.({ step: 'clone', status: 'running', count: approved.length });
    ({ repositories: prepared } = await execute('repositories', { repositories: approved }));
    await onStep?.({ step: 'clone', status: 'completed', count: prepared.length });
  }
  let output = '';
  if (installScript.trim()) {
    await onStep?.({ step: 'install', status: 'running' });
    const result = await execute('install', { script: installScript });
    output = sanitize(result.output);
    await onStep?.({ step: 'install', status: 'completed', output });
  }
  return { repositories: prepared, output };
}
