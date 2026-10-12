#!/usr/bin/env python3
"""Start/stop a disposable loopback API preview, isolated from production data."""
import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess
import time
import urllib.request
from deploy import load_release


def run(args):
    return subprocess.check_output(args, text=True).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('start', 'stop'))
    parser.add_argument('--bundle', required=True, type=Path)
    parser.add_argument('--port', type=int, default=33010)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error('port must be between 1024 and 65535')
    bundle = args.bundle.resolve()
    release = load_release(bundle)
    name = 'new-api-codex-preview-' + release['release']
    os.umask(0o077)
    if args.action == 'stop':
        info = json.loads(run(['docker', 'inspect', name]))[0]
        if info['Config']['Labels'].get('new-api.codex.preview') != release['release']:
            raise RuntimeError('Container is not this release preview')
        run(['docker', 'rm', '-f', name])
        run(['docker', 'network', 'rm', name])
        print(json.dumps({'preview_stopped': name, 'production_changed': False}))
        return
    data = bundle / 'preview-data'
    data.mkdir(exist_ok=False, mode=0o700)
    secret = bundle / 'preview.private.env'
    secret.write_text('SESSION_SECRET=' + secrets.token_hex(32) + '\nCRYPTO_SECRET=' + secrets.token_hex(32) + '\nSQLITE_PATH=/data/preview.db\nTRUSTED_PROXIES=none\nTZ=Asia/Shanghai\n')
    # No production environment variables, DB, runner key, bind mounts or Docker socket.
    # An internal network also prevents this preview from contacting real upstreams.
    run(['docker', 'network', 'create', '--internal', '--label', 'new-api.codex.preview=' + release['release'], name])
    try:
        run(['docker', 'run', '-d', '--name', name, '--label', 'new-api.codex.preview=' + release['release'], '--network', name, '--publish', '127.0.0.1:' + str(args.port) + ':3000', '--env-file', str(secret), '--mount', 'type=bind,src=' + str(data) + ',dst=/data', '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '1g', '--cpus', '2', release['api_image_id']])
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen('http://127.0.0.1:' + str(args.port) + '/api/status', timeout=3) as response:
                    if json.load(response).get('success') is True:
                        print(json.dumps({'preview_url': 'http://127.0.0.1:' + str(args.port), 'container': name, 'production_changed': False, 'scope': 'Fresh SQLite API/UI; upstream and production runner intentionally disconnected'}))
                        return
            except Exception:
                time.sleep(2)
        raise RuntimeError('Preview health check failed')
    except BaseException:
        subprocess.run(['docker', 'rm', '-f', name], capture_output=True)
        subprocess.run(['docker', 'network', 'rm', name], capture_output=True)
        raise


if __name__ == '__main__':
    main()
