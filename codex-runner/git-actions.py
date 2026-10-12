"""Explicit Git actions; loaded after workspace-repository.py's shared helpers."""
import shutil
import hashlib

OFFLINE_GIT = git
DIFF_LIMIT = 2 * 1024 * 1024
ACTION_FLAGS = [*FLAGS, "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false"]
CREDENTIAL_HELPER = '!f() { [ "$1" = get ] || return 0; p=; h=; while IFS= read -r line; do case "$line" in protocol=*) p=${line#protocol=} ;; host=*) h=${line#host=} ;; esac; done; [ "$p" = https ] && [ "$h" = github.com ] && printf "username=x-access-token\\npassword=%s\\n" "$GH_TOKEN"; }; f'


def git_command(root, arguments, extra_env=None, network=False, allow_failure=False, truncate=False):
    env = {**ENV, "GIT_CEILING_DIRECTORIES": str(Path(root).parent), **(extra_env or {})}
    flags = list(ACTION_FLAGS)
    if network:
        env.update({"GIT_ALLOW_PROTOCOL": "https", "GH_TOKEN": os.environ["GH_TOKEN"]})
        flags += ["-c", "protocol.https.allow=always", "-c", "http.followRedirects=false", "-c", "credential.https://github.com.helper=" + CREDENTIAL_HELPER]
    with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(["git", *flags, *arguments], cwd=root, env=env, stdout=output, stderr=errors)
        try:
            code = process.wait(timeout=105 if network else 30)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
            raise RepositoryError("Git operation timed out; refresh repository status before retrying", "repository_timeout", 504)
        output.seek(0)
        content = output.read(DIFF_LIMIT + 1)
    if code and not allow_failure:
        raise RepositoryError("Git could not complete this operation; repository changes have been preserved", "git_action_failed")
    if len(content) > DIFF_LIMIT and not truncate:
        raise RepositoryError("Git output exceeds the supported size", "repository_too_large", 413)
    return code, content[:DIFF_LIMIT].decode("utf-8", errors="replace"), len(content) > DIFF_LIMIT


def github_remote(config, name="origin"):
    if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}", name):
        raise RepositoryError("Invalid Git remote", "invalid_remote", 400)
    values = [value for key, value in config if key.lower() == "remote." + name.lower() + ".url"]
    if len(values) != 1:
        raise RepositoryError("Select an existing GitHub remote", "remote_not_found", 404)
    value = values[0]
    match = re.fullmatch(r"(?:https://github\.com/|git@github\.com:|ssh://git@github\.com/)([A-Za-z0-9][A-Za-z0-9-]{0,38})/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?/?", value)
    if not match or match.group(2) in (".", ".."):
        raise RepositoryError("Publishing requires a GitHub.com remote without embedded credentials", "remote_unsupported")
    repository = match.group(1) + "/" + match.group(2)
    return {"name": name, "repository": repository, "url": "https://github.com/" + repository + ".git"}


def git_status(root, config):
    result = metadata(root, config)
    _, porcelain = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"])
    entries = porcelain.split("\0")
    files = []
    index = 0
    while index < len(entries) and entries[index]:
        item = entries[index]
        index += 1
        left, right, path = item[0], item[1], item[3:]
        file = {"path": path, "indexStatus": left, "worktreeStatus": right, "status": "A" if left == "?" else right if right != " " else left}
        if left in "RC" or right in "RC":
            file["originalPath"] = entries[index]
            index += 1
        files.append(file)
    conflicts = any(file["indexStatus"] + file["worktreeStatus"] in ("DD", "AU", "UD", "UA", "DU", "AA", "UU") for file in files)
    locked = any((root / ".git" / name).exists() for name in ("index.lock", "HEAD.lock", "codex-actions.lock"))
    reason = "repository_conflict" if conflicts else "repository_busy" if locked or result["checkoutReason"] == "operation_in_progress" else "submodules" if result["hasSubmodules"] else "detached_head" if result["detached"] else None
    upstream_code, upstream = git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], allow_failure=True)
    ahead = behind = None
    if not upstream_code and result["head"]:
        code, counts = git(root, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], allow_failure=True)
        if not code:
            ahead, behind = map(int, counts.split())
    default_code, default_ref = git(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], allow_failure=True)
    authenticated = bool(os.environ.get("GH_TOKEN"))
    gh_available = shutil.which("gh", path=ENV["PATH"]) is not None
    publish_remotes = []
    for remote in result["remotes"]:
        try:
            publish_remotes.append(github_remote(config, remote["name"]))
        except RepositoryError:
            pass
    remote_reason = None if publish_remotes else "remote_unsupported"
    publish_reason = reason or ("unborn_branch" if not result["head"] else None) or remote_reason or ("github_auth_required" if not authenticated else None)
    pr_reason = publish_reason or ("gh_unavailable" if not gh_available else None)
    diff = ""
    truncated = False
    if not result["hasSubmodules"] and not conflicts:
        with tempfile.TemporaryDirectory(prefix="codex-git-diff-") as directory:
            env = {"GIT_INDEX_FILE": str(Path(directory) / "index")}
            git_command(root, ["read-tree", "HEAD"] if result["head"] else ["read-tree", "--empty"], env)
            git_command(root, ["add", "--intent-to-add", "--all", "--", "."], env)
            base = "HEAD" if result["head"] else "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
            _, diff, truncated = git_command(root, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", base, "--", "."], env, truncate=True)
    fingerprint = hashlib.sha256()
    fingerprint.update((result["head"] or "").encode())
    fingerprint.update(porcelain.encode())
    _, index_entries = git(root, ["ls-files", "--stage", "-z"])
    fingerprint.update(index_entries.encode())
    for file in files:
        location = root / file["path"]
        if location.exists() or location.is_symlink():
            fingerprint.update(str(location.lstat().st_mode).encode())
        # Hash all current bytes even when the rendered patch is truncated.
        # Never follow a tracked symlink to a location outside the project.
        if location.is_symlink():
            fingerprint.update(os.readlink(location).encode())
        elif location.is_file() and all(not parent.is_symlink() for parent in location.parents if parent != root.parent):
            with location.open("rb") as content:
                while True:
                    block = content.read(65536)
                    if not block:
                        break
                    fingerprint.update(block)
        fingerprint.update(b"\0")
    result.update({
        "files": files[:5000], "diff": diff, "truncated": truncated or len(files) > 5000,
        "upstream": upstream.strip() if not upstream_code else None, "ahead": ahead, "behind": behind,
        "defaultBranch": default_ref.strip().removeprefix("refs/remotes/origin/") if not default_code else None,
        "commitSupported": reason is None and bool(files), "commitReason": reason or (None if files else "no_changes"),
        "pushSupported": publish_reason is None, "pushReason": publish_reason,
        "pullRequestSupported": pr_reason is None, "pullRequestReason": pr_reason,
        "githubAuthenticated": authenticated, "ghAvailable": gh_available,
        "publishRemotes": publish_remotes, "statusVersion": fingerprint.hexdigest(),
    })
    return result


def selected_paths(root, request, status):
    paths = request.get("paths")
    all_files = request.get("all", False)
    if not isinstance(all_files, bool) or (all_files and paths is not None) or (not all_files and (not isinstance(paths, list) or not paths)):
        raise RepositoryError("Select changed files or explicitly choose all files", "invalid_paths", 400)
    changed = {file["path"]: file for file in status["files"]}
    if status["truncated"] and all_files:
        raise RepositoryError("Review a smaller selection of files before committing", "repository_too_large", 413)
    if all_files:
        paths = list(changed)
    if len(paths) > 5000:
        raise RepositoryError("Too many selected paths", "invalid_paths", 400)
    selected = []
    for path in paths:
        if not isinstance(path, str) or not path or len(path) > 4096 or path.startswith("/") or "\0" in path or "\\" in path or any(part in ("", ".", "..", ".git") for part in path.split("/")) or path not in changed:
            raise RepositoryError("A selected path is invalid or is no longer changed; refresh the changes list", "invalid_paths", 400)
        current = root
        for part in path.split("/")[:-1]:
            current = current / part
            if current.is_symlink():
                raise RepositoryError("A selected path passes through a symbolic link", "invalid_paths", 400)
        selected.append(path)
        if changed[path].get("originalPath"):
            selected.append(changed[path]["originalPath"])
    return list(dict.fromkeys(selected))


def commit_changes(root, config, request, status):
    message = request.get("message")
    if not isinstance(message, str) or not message.strip() or len(message) > 16000 or "\0" in message:
        raise RepositoryError("Enter a commit message of at most 16000 characters", "invalid_commit_message", 400)
    paths = selected_paths(root, request, status)
    lock_path = root / ".git/index.lock"
    try:
        lock = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        raise RepositoryError("The repository is busy; wait for the current Git operation", "repository_busy")
    try:
        with os.fdopen(lock, "wb") as locked_index, tempfile.TemporaryDirectory(prefix="codex-git-commit-") as directory:
            index_path = Path(directory) / "commit-index"
            preserved_index = Path(directory) / "preserved-index"
            if (root / ".git/index").exists():
                shutil.copyfile(root / ".git/index", preserved_index)
            env = {"GIT_INDEX_FILE": str(index_path), "GIT_LITERAL_PATHSPECS": "1"}
            git_command(root, ["read-tree", "HEAD"] if status["head"] else ["read-tree", "--empty"], env)
            git_command(root, ["add", "--all", "--", *paths], env)
            code, _, _ = git_command(root, ["diff", "--cached", "--quiet", "--no-ext-diff", "--no-textconv"], env, allow_failure=True)
            if code == 0:
                raise RepositoryError("The selected files have no changes to commit", "no_changes")
            if code != 1:
                raise RepositoryError("Selected changes could not be prepared", "git_action_failed")
            # The repository's explicit identity wins; never change git config.
            identity = dict(config)
            author = identity.get("user.name") or "New API Codex"
            email = identity.get("user.email") or "codex@localhost"
            git_command(root, ["-c", "user.name=" + author, "-c", "user.email=" + email, "commit", "--no-verify", "--no-gpg-sign", "-m", message.strip()], env)
            _, sha = git(root, ["rev-parse", "HEAD"])
            # Preserve every unselected staged change, including partial staging.
            preserved_env = {"GIT_INDEX_FILE": str(preserved_index), "GIT_LITERAL_PATHSPECS": "1"}
            if not preserved_index.exists():
                git_command(root, ["read-tree", "--empty"], preserved_env)
            git_command(root, ["reset", "--quiet", "HEAD", "--", *paths], preserved_env)
            locked_index.write(preserved_index.read_bytes())
            locked_index.flush()
            os.fsync(locked_index.fileno())
        os.replace(lock_path, root / ".git/index")
        return {"sha": sha.strip(), "subject": message.strip().splitlines()[0]}
    finally:
        lock_path.unlink(missing_ok=True)


def run_gh(arguments, cwd):
    env = {**ENV, "GH_TOKEN": os.environ["GH_TOKEN"], "GH_HOST": "github.com", "GH_PROMPT_DISABLED": "1", "GH_BROWSER": "false", "GH_CONFIG_DIR": str(cwd), "NO_COLOR": "1"}
    with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(["gh", *arguments], cwd=cwd, env=env, stdout=output, stderr=errors)
        try:
            code = process.wait(timeout=100)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
            raise RepositoryError("GitHub did not confirm the request; refresh before retrying", "github_timeout", 504)
        output.seek(0)
        content = output.read(65537)
    if code or len(content) > 65536:
        raise RepositoryError("GitHub could not complete this request; check repository access and refresh before retrying", "github_request_failed")
    return content.decode("utf-8", errors="replace").strip()


def publish_changes(root, config, request, status):
    remote = github_remote(config, request.get("remote", "origin"))
    if not os.environ.get("GH_TOKEN"):
        raise RepositoryError("Connect your GitHub account before publishing", "github_auth_required", 401)
    branch = validate_branch(root, status["branch"])
    with tempfile.TemporaryDirectory(prefix="codex-git-publish-") as directory:
        # Never load the project's network configuration. This pristine Git dir
        # shares only the already validated object database, without any hooks,
        # URL rewrites, push URLs, proxy settings, credential helpers or headers.
        neutral = Path(directory)
        git_command(neutral, ["init", "--bare", "--template=", str(neutral / "repository.git")])
        env = {"GIT_DIR": str(neutral / "repository.git"), "GIT_OBJECT_DIRECTORY": str(root / ".git/objects")}
        if (root / ".git/shallow").exists():
            shutil.copyfile(root / ".git/shallow", neutral / "repository.git/shallow")
        if request["operation"] == "push":
            code, _, _ = git_command(neutral, ["push", "--porcelain", "--no-verify", "--recurse-submodules=no", "--", remote["url"], status["head"] + ":refs/heads/" + branch], env, network=True, allow_failure=True)
            if code:
                raise RepositoryError("Push was not confirmed; check GitHub access or branch divergence and refresh before retrying", "push_failed")
            git(root, ["update-ref", "refs/remotes/" + remote["name"] + "/" + branch, status["head"]])
            git(root, ["config", "branch." + branch + ".remote", remote["name"]])
            git(root, ["config", "branch." + branch + ".merge", "refs/heads/" + branch])
            return {"push": {"remote": remote["name"], "branch": branch, "head": status["head"]}}
        if not status["ghAvailable"]:
            raise RepositoryError("GitHub CLI is unavailable in this environment", "gh_unavailable", 503)
        title, body = request.get("title"), request.get("body", "")
        if not isinstance(title, str) or not title.strip() or len(title) > 256 or any(char in title for char in ("\0", "\n", "\r")) or not isinstance(body, str) or len(body) > 64000 or "\0" in body or not isinstance(request.get("draft", True), bool):
            raise RepositoryError("Enter a valid pull request title and description", "invalid_pull_request", 400)
        base = validate_branch(root, request.get("base"))
        if branch == base:
            raise RepositoryError("Choose a base branch different from the current branch", "invalid_base", 400)
        _, references, _ = git_command(neutral, ["ls-remote", "--heads", "--", remote["url"], "refs/heads/" + branch, "refs/heads/" + base], env, network=True)
        refs = dict(line.split("\t")[::-1] for line in references.splitlines() if "\t" in line)
        if refs.get("refs/heads/" + branch) != status["head"]:
            raise RepositoryError("Push the current commit before creating a pull request", "push_required")
        if "refs/heads/" + base not in refs:
            raise RepositoryError("The base branch does not exist on GitHub", "base_not_found", 404)
        # The list makes retries after an uncertain response idempotent.
        existing = json.loads(run_gh(["api", "--method", "GET", "repos/" + remote["repository"] + "/pulls", "-f", "head=" + remote["repository"].split("/")[0] + ":" + branch, "-f", "base=" + base, "-f", "state=open", "-f", "per_page=100"], neutral))
        for pull_request in existing:
            if (pull_request.get("head", {}).get("repo") or {}).get("full_name", "").lower() != remote["repository"].lower():
                continue
            url = pull_request.get("html_url", "")
            if not re.fullmatch(r"https://github\.com/" + re.escape(remote["repository"]) + r"/pull/\d+", url):
                continue
            return {"pullRequest": {"url": url, "number": pull_request["number"], "existing": True}}
        body_path = neutral / "pull-request-body.md"
        body_path.write_text(body, encoding="utf-8")
        args = ["pr", "create", "--repo", remote["repository"], "--head", branch, "--base", base, "--title", title.strip(), "--body-file", str(body_path)]
        if request.get("draft", True):
            args.append("--draft")
        output = run_gh(args, neutral)
        match = re.search(r"https://github\.com/" + re.escape(remote["repository"]) + r"/pull/(\d+)\b", output)
        if not match:
            raise RepositoryError("GitHub did not return a pull request URL; refresh before retrying", "github_request_failed")
        return {"pullRequest": {"url": match.group(0), "number": int(match.group(1)), "existing": False}}


def run_git_action(request):
    root = checked_root(request.get("cwd"))
    operation = request.get("operation")
    if not check_git_directory(root):
        if operation != "status":
            raise RepositoryError("This project is not a Git repository", "repository_not_found", 404)
        return {"available": False, "branch": None, "head": None, "dirty": False, "detached": False, "files": [], "diff": "", "truncated": False, "remotes": [], "upstream": None, "ahead": None, "behind": None, "defaultBranch": None, "commitSupported": False, "commitReason": "not_repository", "pushSupported": False, "pushReason": "not_repository", "pullRequestSupported": False, "pullRequestReason": "not_repository", "githubAuthenticated": bool(os.environ.get("GH_TOKEN")), "ghAvailable": shutil.which("gh", path=ENV["PATH"]) is not None}
    config = repository_config(root)
    status = git_status(root, config)
    if operation == "status":
        return status
    if operation not in ("commit", "push", "pull-request"):
        raise RepositoryError("Unknown Git operation", "invalid_git_operation", 400)
    if "expectedHead" in request and request["expectedHead"] != status["head"]:
        raise RepositoryError("The repository changed since review; refresh before continuing", "repository_changed")
    if operation == "commit" and "expectedStatusVersion" in request and request["expectedStatusVersion"] != status["statusVersion"]:
        raise RepositoryError("Files changed since review; refresh the changes before committing", "repository_changed")
    reason = status["commitReason"]
    if reason not in (None, "no_changes"):
        raise RepositoryError("Resolve conflicts or finish the current Git operation before continuing", reason)
    if operation == "commit" and not status["files"]:
        raise RepositoryError("There are no changes to commit", "no_changes")
    if operation != "commit" and not status["head"]:
        raise RepositoryError("Create a commit before publishing", "unborn_branch")
    action_lock = root / ".git/codex-actions.lock"
    try:
        descriptor = os.open(action_lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        raise RepositoryError("Another Git action is in progress", "repository_busy")
    try:
        os.close(descriptor)
        if operation == "commit":
            result = {"commit": commit_changes(root, config, request, status)}
        else:
            result = publish_changes(root, config, request, status)
    finally:
        action_lock.unlink(missing_ok=True)
    return {**result, "status": git_status(root, repository_config(root))}


try:
    payload = json.load(sys.stdin)
    if not isinstance(payload, dict):
        raise RepositoryError("Invalid Git request", "invalid_git_request", 400)
    print(json.dumps({"ok": True, "result": run_git_action(payload)}))
except RepositoryError as error:
    print(json.dumps({"ok": False, "error": str(error), "code": error.code, "statusCode": error.status}))
    sys.exit(1)
except (OSError, ValueError, TypeError, KeyError):
    print(json.dumps({"ok": False, "error": "Git operation could not be completed; refresh repository status before retrying", "code": "git_action_failed", "statusCode": 409}))
    sys.exit(1)
