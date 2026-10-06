#!/usr/bin/env python3
"""Bounded workspace access. Never follow project-controlled symbolic links."""
import base64
import hashlib
import io
import json
import os
import secrets
import stat
import sys
import zipfile

MAX_FILE = 1024 * 1024
MAX_ARCHIVE = 25 * 1024 * 1024
MAX_EXPANDED = 100 * 1024 * 1024
MAX_FILES = 5000
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
EXPORT_EXCLUDED = {".git", "node_modules", ".ssh", ".aws", ".azure", ".codex", ".npmrc", ".pypirc", ".netrc", "auth.json"}


class Rejected(Exception):
    def __init__(self, message, code="invalid_path", status=400):
        super().__init__(message)
        self.code, self.status = code, status


def parts(path, empty=False):
    if not isinstance(path, str) or len(path) > 1024 or "\\" in path or path.startswith("/"):
        raise Rejected("Invalid workspace path")
    if not path and empty:
        return []
    result = path.split("/")
    if len(result) > 128 or any(p in ("", ".", "..", ".git") or any(ord(c) < 32 for c in p) for p in result):
        raise Rejected("Invalid workspace path")
    return result


def directory(root, components, create=False, created=None):
    fd = os.dup(root)
    try:
        for index, component in enumerate(components):
            if create:
                try:
                    os.mkdir(component, 0o755, dir_fd=fd)
                    if created is not None:
                        created.append(components[:index + 1])
                    if os.geteuid() == 0:
                        os.chown(component, 1000, 1000, dir_fd=fd, follow_symlinks=False)
                except FileExistsError:
                    pass
            next_fd = os.open(component, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


def read_bytes(root, path, limit=MAX_FILE):
    components = parts(path)
    parent = directory(root, components[:-1])
    try:
        fd = os.open(components[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode):
                raise Rejected("Only regular files are supported")
            if info.st_size > limit:
                raise Rejected("File exceeds the size limit", "file_too_large", 413)
            with os.fdopen(fd, "rb", closefd=False) as source:
                data = source.read(limit + 1)
            if len(data) > limit:
                raise Rejected("File exceeds the size limit", "file_too_large", 413)
            return data
        finally:
            os.close(fd)
    finally:
        os.close(parent)


def put_bytes(root, path, data, expected=None, check=False, created=None):
    components = parts(path)
    parent = directory(root, components[:-1], create=True, created=created)
    temp_name = ".codex-upload-" + secrets.token_hex(12)
    try:
        try:
            current = read_bytes(root, path, MAX_EXPANDED)
        except FileNotFoundError:
            current = None
        if check and (hashlib.sha256(current).hexdigest() if current is not None else None) != expected:
            raise Rejected("File changed; reload before saving", "file_conflict", 409)
        fd = os.open(temp_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=parent)
        try:
            with os.fdopen(fd, "wb", closefd=False) as output:
                output.write(data)
                output.flush()
                os.fsync(fd)
            if os.geteuid() == 0:
                os.fchown(fd, 1000, 1000)
        finally:
            os.close(fd)
        os.rename(temp_name, components[-1], src_dir_fd=parent, dst_dir_fd=parent)
    finally:
        try:
            os.unlink(temp_name, dir_fd=parent)
        except FileNotFoundError:
            pass
        os.close(parent)


def run(root, request):
    operation = request["operation"]
    path = request.get("path", "")
    if operation == "list":
        fd = directory(root, parts(path, empty=True))
        try:
            entries = []
            for name in sorted(os.listdir(fd)):
                if name == ".git" or name.startswith(".codex-upload-"):
                    continue
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
                    continue
                entries.append({"name": name, "path": f"{path}/{name}" if path else name,
                                "type": "directory" if stat.S_ISDIR(info.st_mode) else "file", "size": info.st_size})
                if len(entries) > MAX_FILES:
                    raise Rejected("Directory has too many entries", "too_many_files", 413)
            entries.sort(key=lambda value: (value["type"] != "directory", value["name"]))
            return {"path": path, "entries": entries}
        finally:
            os.close(fd)
    if operation == "read":
        data = read_bytes(root, path)
        try:
            content = data.decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            raise Rejected("Binary files cannot be edited as text", "binary_file", 415)
        if "\x00" in content:
            raise Rejected("Binary files cannot be edited as text", "binary_file", 415)
        return {"path": path, "content": content, "hash": hashlib.sha256(data).hexdigest(), "size": len(data)}
    if operation == "write":
        content = request.get("content")
        if not isinstance(content, str) or "\x00" in content:
            raise Rejected("Content must be UTF-8 text")
        data = content.encode("utf-8")
        if len(data) > MAX_FILE:
            raise Rejected("File exceeds the 1 MiB editing limit", "file_too_large", 413)
        if "expectedHash" not in request:
            raise Rejected("expectedHash is required", "hash_required")
        put_bytes(root, path, data, request["expectedHash"], check=True)
        return {"path": path, "content": content, "hash": hashlib.sha256(data).hexdigest(), "size": len(data)}
    if operation == "import":
        try:
            archive_bytes = base64.b64decode(request["data"], validate=True)
        except (ValueError, KeyError):
            raise Rejected("Invalid ZIP payload", "invalid_archive")
        if len(archive_bytes) > MAX_ARCHIVE:
            raise Rejected("ZIP exceeds 25 MiB", "archive_too_large", 413)
        try:
            archive = zipfile.ZipFile(io.BytesIO(archive_bytes))
            names, files, total = set(), [], 0
            infos = archive.infolist()
            if len(infos) > MAX_FILES:
                raise Rejected("ZIP contains too many entries", "too_many_files", 413)
            for info in infos:
                name = info.filename.rstrip("/") if info.is_dir() else info.filename
                parts(name)
                mode = info.external_attr >> 16
                if stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR) or info.flag_bits & 1:
                    raise Rejected("ZIP links, special files and encrypted entries are unsupported", "invalid_archive")
                if name in names:
                    raise Rejected("ZIP contains duplicate paths", "invalid_archive")
                names.add(name)
                total += info.file_size
                if total > MAX_EXPANDED or info.file_size > MAX_EXPANDED:
                    raise Rejected("ZIP expands beyond 100 MiB", "archive_too_large", 413)
                if not info.is_dir():
                    files.append((name, archive.read(info)))
            file_names = {name for name, _ in files}
            for name, _ in files:
                components = parts(name)
                if any("/".join(components[:i]) in file_names for i in range(1, len(components))):
                    raise Rejected("ZIP has conflicting file and directory paths", "invalid_archive")
                # Existing symbolic links must be rejected before beginning the import.
                try:
                    fd = directory(root, components[:-1])
                except FileNotFoundError:
                    continue
                try:
                    try:
                        existing = os.stat(components[-1], dir_fd=fd, follow_symlinks=False)
                        raise Rejected("ZIP contains a path that already exists", "file_conflict", 409)
                    except FileNotFoundError:
                        pass
                finally:
                    os.close(fd)
            # Validate the complete archive, including CRC, before changing any files.
            added, created = [], []
            try:
                for name, data in files:
                    put_bytes(root, name, data, None, check=True, created=created)
                    added.append(name)
            except BaseException:
                for name in reversed(added):
                    components = parts(name)
                    parent = directory(root, components[:-1])
                    try:
                        os.unlink(components[-1], dir_fd=parent)
                    finally:
                        os.close(parent)
                for components in reversed(created):
                    parent = directory(root, components[:-1])
                    try:
                        os.rmdir(components[-1], dir_fd=parent)
                    finally:
                        os.close(parent)
                raise
            return {"files": len(files), "bytes": total}
        except (zipfile.BadZipFile, NotImplementedError, RuntimeError, EOFError):
            raise Rejected("Invalid or unsupported ZIP archive", "invalid_archive")
    if operation == "export":
        target = io.BytesIO()
        count, total, skipped = 0, 0, 0
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=3) as archive:
            pending = [([], os.dup(root))]
            try:
                while pending:
                    prefix, fd = pending.pop()
                    try:
                        for name in sorted(os.listdir(fd)):
                            if name in EXPORT_EXCLUDED or name.startswith(".env") or name.endswith((".pem", ".key", ".p12", ".pfx")) or name.startswith(".codex-upload-"):
                                skipped += 1
                                continue
                            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                            item = prefix + [name]
                            parts("/".join(item))
                            count += 1
                            if count > MAX_FILES:
                                raise Rejected("Workspace contains too many files", "too_many_files", 413)
                            if stat.S_ISDIR(info.st_mode):
                                pending.append((item, os.open(name, DIR_FLAGS, dir_fd=fd)))
                            elif stat.S_ISREG(info.st_mode):
                                data = read_bytes(root, "/".join(item), MAX_EXPANDED - total)
                                total += len(data)
                                archive.writestr("/".join(item), data)
                            else:
                                skipped += 1
                    finally:
                        os.close(fd)
            finally:
                for _, fd in pending:
                    os.close(fd)
        if target.tell() > MAX_EXPANDED:
            raise Rejected("Export exceeds 100 MiB", "archive_too_large", 413)
        return {"data": base64.b64encode(target.getvalue()).decode(), "files": count, "bytes": total, "skipped": skipped}
    raise Rejected("Unknown file operation")


try:
    root_fd = os.open(sys.argv[1], DIR_FLAGS)
    try:
        request = json.load(sys.stdin)
        print(json.dumps({"ok": True, "result": run(root_fd, request)}, ensure_ascii=False))
    finally:
        os.close(root_fd)
except Rejected as error:
    print(json.dumps({"ok": False, "error": str(error), "code": error.code, "statusCode": error.status}))
except FileNotFoundError:
    print(json.dumps({"ok": False, "error": "File or directory not found", "code": "not_found", "statusCode": 404}))
except (OSError, ValueError, KeyError, TypeError):
    print(json.dumps({"ok": False, "error": "Workspace path is unavailable or unsafe", "code": "unsafe_path", "statusCode": 400}))
