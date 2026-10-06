#!/usr/bin/env python3
"""Supervise one project's App Server without stopping the user container."""
import json
import os
import pathlib
import re
import signal
import subprocess
import sys
import time

operation, workspace = sys.argv[1:3]
if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", workspace):
    raise SystemExit(2)
marker = b'NEW_API_CODEX_WORKSPACE_ID=' + workspace.encode()
record = pathlib.Path('/tmp') / ('new-api-codex-process-' + workspace + '.json')

def process_info(pid):
    try:
        # comm can contain spaces and parentheses; remaining fields start at state.
        fields = pathlib.Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
        return {'pid': int(pid), 'parent': int(fields[1]), 'group': int(fields[2]), 'session': int(fields[3]), 'start': fields[19]}
    except (OSError, ValueError, IndexError):
        return None

def marked(pid):
    try:
        return marker in pathlib.Path(f'/proc/{pid}/environ').read_bytes().split(b'\0')
    except OSError:
        return False

def cleanup(identity=None):
    root = identity
    if root is None:
        try:
            root = json.loads(record.read_text())
            current = process_info(root['pid'])
            # A dead session leader can leave children in its session. Do not
            # trust a PID reused by an unrelated process after an old task died.
            if current and current['start'] != root['start']:
                root = None
        except (OSError, ValueError, KeyError, TypeError):
            root = None
    captured = {}
    for sig in (signal.SIGTERM, signal.SIGKILL):
        processes = [value for entry in pathlib.Path('/proc').iterdir() if entry.name.isdigit() and (value := process_info(entry.name))]
        selected = {value['pid'] for value in processes if value['pid'] != os.getpid() and ((sig == signal.SIGTERM and marked(value['pid'])) or root and value['session'] == root['session'] or captured.get(value['pid']) == value['start'])}
        # Include children that unset environment variables or create a new
        # process group. This is lifecycle cleanup within one user's container,
        # not a security boundary between that user's own projects.
        for _ in range(len(processes)):
            found = {value['pid'] for value in processes if value['parent'] in selected and value['pid'] != os.getpid()}
            if found <= selected:
                break
            selected.update(found)
        captured.update({value['pid']: value['start'] for value in processes if value['pid'] in selected})
        for pid in selected:
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                pass
        if sig == signal.SIGTERM:
            time.sleep(0.3)
    try:
        # A new task may already own a new record after the previous App Server
        # exited. An old supervisor must never remove that task's lifecycle ID.
        current = json.loads(record.read_text())
        if root and current.get('pid') == root.get('pid') and current.get('start') == root.get('start'):
            record.unlink()
    except (FileNotFoundError, ValueError, TypeError):
        pass

if operation == 'stop':
    cleanup()
    print(json.dumps({'stopped': True}))
elif operation == 'run':
    argv = sys.argv[3:]
    if not argv:
        raise SystemExit(2)
    child = subprocess.Popen(argv, env={**os.environ, 'NEW_API_CODEX_WORKSPACE_ID': workspace}, start_new_session=True)
    identity = process_info(child.pid)
    if identity:
        # /tmp is local to this container, never host state. It is intentionally
        # only a best-effort lifecycle index accessible by this same user.
        record.write_text(json.dumps(identity))
    def stop(*_):
        cleanup(identity)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        code = child.wait()
    finally:
        cleanup(identity)
    raise SystemExit(code)
else:
    raise SystemExit(2)
