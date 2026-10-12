#!/usr/bin/env python3
"""Read-only preflight by default; explicit apply/rollback only touch API and runner."""
import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import time
import urllib.request

COMPOSE = Path(os.environ.get('CODEX_RELEASE_COMPOSE', '/etc/new-api/compose.private.json'))
PROJECT = os.environ.get('CODEX_RELEASE_PROJECT', 'new-api')
RUNNER = Path(os.environ.get('CODEX_RELEASE_RUNNER', '/opt/new-api-codex'))
DATA = Path(os.environ.get('CODEX_RELEASE_DATA', '/var/lib/new-api-codex'))
KEY = Path(os.environ.get('CODEX_RELEASE_KEY', '/etc/new-api-codex/runner.key'))
RUNNER_URL = os.environ.get('CODEX_RELEASE_RUNNER_URL', 'http://172.31.241.1:7310')
SERVICE = os.environ.get('CODEX_RELEASE_SERVICE', 'new-api-codex.service')
DROPIN = Path(os.environ.get('CODEX_RELEASE_DROPIN', '/etc/systemd/system/new-api-codex.service.d/90-codex-release.conf'))
ACTIVE = {'starting', 'running', 'waiting_approval', 'queued', 'inProgress'}


def run(args):
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode:
        # Compose inspection/error output can contain credentials: never echo it.
        raise RuntimeError('Command failed: ' + ' '.join(args[:3]))
    return result.stdout.strip()


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def inspect(name):
    return json.loads(run(['docker', 'inspect', name]))[0]


def atomic_write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o600
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def get_json(url, owner=None):
    headers = {} if owner is None else {'X-Codex-Runner-Key': KEY.read_text().strip(), 'X-Codex-Admin-Id': str(owner)}
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=10) as response:
        data = json.load(response)
    if data.get('success') is not True:
        raise RuntimeError('Health/runner request failed')
    return data.get('data', {})


def assert_idle():
    """Use live runner state for every owner and every conversation, not stale files."""
    owners = set()
    for path in (DATA / 'state').glob('*.json'):
        state = json.loads(path.read_text())
        owners.add(int(state['workspace']['ownerId']))
    total = 0
    for owner in sorted(owners or {1}):
        for workspace in get_json(RUNNER_URL + '/workspaces', owner)['workspaces']:
            if workspace.get('activeTurnId') or workspace.get('status') in ACTIVE:
                raise RuntimeError('Active Codex work exists; wait for it to finish')
            root = RUNNER_URL + '/workspaces/' + workspace['id']
            detail = get_json(root, owner)
            conversations = detail.get('conversations')
            if not isinstance(conversations, list):
                raise RuntimeError('Runner did not expose all conversations; refusing to infer idle')
            for conversation in conversations:
                entry = get_json(root + '?conversation=' + conversation['id'], owner)
                current = entry['workspace']
                if current.get('activeTurnId') or current.get('status') in ACTIVE or entry.get('pendingApprovals') or entry.get('queuedTurns'):
                    raise RuntimeError('Active task, approval, or queued turn exists; deployment deferred')
                if any(turn.get('status') in ACTIVE for turn in (entry.get('thread') or {}).get('turns', [])):
                    raise RuntimeError('A task is still active; deployment deferred')
                total += 1
    return {'owners': len(owners), 'conversations': total, 'active_tasks': 0, 'approvals': 0, 'queued_turns': 0}


def other_containers():
    result = {}
    services = json.loads(COMPOSE.read_text())['services']
    for service, config in services.items():
        if service == 'new-api':
            continue
        name = config.get('container_name')
        if not name:
            raise RuntimeError('Production service has no fixed container identity')
        info = inspect(name)
        result[name] = {'id': info['Id'], 'image': info['Image'], 'started_at': info['State']['StartedAt']}
    return result


def load_release(path):
    manifest = json.loads((path / 'release.json').read_text())
    for key, value in manifest.get('runner_environment', {}).items():
        if key == 'CODEX_MAX_ACTIVE' and value in [str(i) for i in range(1, 9)]:
            continue
        if key == 'CODEX_EFFORTS' and isinstance(value, str) and value and all(effort in {'low', 'medium', 'high', 'xhigh', 'max', 'ultra'} for effort in value.split(',')):
            continue
        if key == 'CODEX_WORKER_MEMORY_MB' and isinstance(value, str) and re.fullmatch(r'[1-9][0-9]{2,6}', value) and 256 <= int(value) <= 1048576:
            continue
        raise RuntimeError('Unsupported runner environment override')
    if digest(path / 'source-sha256.json') != manifest['source_manifest_sha256']:
        raise RuntimeError('Source inventory changed since build')
    archive = path / manifest['runner_archive']
    if archive.parent.resolve() != path.resolve() or digest(archive) != manifest['runner_sha256']:
        raise RuntimeError('Runner artifact checksum mismatch')
    for kind in ('api', 'worker'):
        if inspect(manifest[kind + '_image'])['Id'] != manifest[kind + '_image_id']:
            raise RuntimeError('Release image changed since build')
    return manifest


def preflight(release):
    manifest = load_release(release)
    api = inspect('new-api')
    labels = api['Config']['Labels']
    if labels.get('com.docker.compose.project') != PROJECT or labels.get('com.docker.compose.project.config_files') != str(COMPOSE):
        raise RuntimeError('Production Compose identity changed; re-audit required')
    compose = json.loads(COMPOSE.read_text())
    if compose['services']['new-api']['image'] != api['Config']['Image']:
        raise RuntimeError('Production container differs from Compose; re-audit required')
    if run(['systemctl', 'is-active', SERVICE]) != 'active':
        raise RuntimeError('Production runner is not active')
    # Reuse personal environments only when their immutable image filesystem is
    # byte-for-byte identical to the candidate. A different helper/runtime layer
    # requires a separate migration; never delete user environments here.
    candidate_rootfs = inspect(manifest['worker_image_id']).get('RootFS')
    if not candidate_rootfs or not candidate_rootfs.get('Layers'):
        raise RuntimeError('Candidate worker has no verifiable image filesystem')
    workers = run(['docker', 'ps', '-a', '--filter', 'label=new-api.codex.managed=true', '--format', '{{.Names}}'])
    compatible_workers = 0
    for name in workers.splitlines():
        worker = inspect(name)
        for mount in worker.get('Mounts', []):
            source = Path(mount.get('Source', '/'))
            if source == DATA or DATA in source.parents:
                if not re.fullmatch(r'new-api-codex-user-[1-9][0-9]*', name) or not worker.get('HostConfig', {}).get('ReadonlyRootfs') or inspect(worker['Image']).get('RootFS') != candidate_rootfs:
                    raise RuntimeError('Existing production worker filesystem differs from the candidate; migrate it separately')
                compatible_workers += 1
                break
    idle = assert_idle()
    get_json('http://127.0.0.1:3000/api/status')
    return {'release': manifest['release'], 'production_image': api['Image'], 'candidate_image': manifest['api_image_id'], 'runner': SERVICE, 'compatible_workers': compatible_workers, **idle}


def wait_health():
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        try:
            get_json('http://127.0.0.1:3000/api/status')
            if get_json(RUNNER_URL + '/status', 1).get('available') is not True:
                raise RuntimeError('Runner runtime unavailable')
            return
        except Exception:
            time.sleep(2)
    raise RuntimeError('API/runner health did not recover within 90 seconds')


def compose_up():
    run(['docker', 'compose', '-p', PROJECT, '-f', str(COMPOSE), 'up', '-d', '--no-deps', '--pull', 'never', 'new-api'])


def restore(release, record):
    # API is already stopped. Restore code/config only; never restore user data or DB.
    run(['systemctl', 'stop', SERVICE])
    backup = Path(record['runner_backup'])
    if backup.exists():
        failed = RUNNER.with_name('new-api-codex.failed-' + record['release'])
        if failed.exists():
            raise RuntimeError('Previous failed-runner directory exists; manual review required')
        if RUNNER.exists():
            RUNNER.rename(failed)
        backup.rename(RUNNER)
    atomic_write(COMPOSE, (release / 'transaction/compose.before.private.json').read_bytes())
    prior_dropin = release / 'transaction/dropin.before.private.conf'
    if record['had_dropin']:
        atomic_write(DROPIN, prior_dropin.read_bytes())
    else:
        DROPIN.unlink(missing_ok=True)
    run(['systemctl', 'daemon-reload'])
    run(['systemctl', 'start', SERVICE])
    compose_up()
    wait_health()
    if other_containers() != record['other_containers']:
        raise RuntimeError('Other containers changed during the transaction; review required')


def apply(release):
    manifest = load_release(release)
    report = preflight(release)
    transaction = release / 'transaction'
    transaction.mkdir(mode=0o700, exist_ok=False)
    backup = RUNNER.with_name('new-api-codex.before-' + manifest['release'])
    staged = RUNNER.with_name('new-api-codex.next-' + manifest['release'])
    if backup.exists() or staged.exists():
        raise RuntimeError('Runner backup/staging path exists; use a unique release')
    record = {'release': manifest['release'], 'runner_backup': str(backup), 'had_dropin': DROPIN.exists(), 'other_containers': other_containers(), 'production_image': report['production_image'], 'state': 'prepared', 'created_at': datetime.now(timezone.utc).isoformat()}
    shutil.copy2(COMPOSE, transaction / 'compose.before.private.json')
    if DROPIN.exists():
        shutil.copy2(DROPIN, transaction / 'dropin.before.private.conf')
    shutil.copytree(RUNNER, staged, symlinks=True)
    for entry in staged.iterdir():
        if entry.is_file() and entry.suffix in {'.mjs', '.py', '.sh'}:
            entry.unlink()
    with tarfile.open(release / manifest['runner_archive'], 'r:gz') as archive:
        for member in archive.getmembers():
            if (member.name != '.dockerignore' and not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,120}', member.name)) or not member.isfile():
                raise RuntimeError('Unsafe runner archive member')
            destination = staged / member.name
            destination.unlink(missing_ok=True)
            with archive.extractfile(member) as source, destination.open('xb') as target:
                shutil.copyfileobj(source, target)
            destination.chmod(0o755 if member.mode & 0o111 else 0o644)
    atomic_write(transaction / 'record.private.json', json.dumps(record, indent=2).encode())
    api_stopped = False
    runner_changed = False
    try:
        if digest(COMPOSE) != digest(transaction / 'compose.before.private.json'):
            raise RuntimeError('Compose changed during staging; re-audit required')
        # Close the ingress race: stop only API, then query runner again before stopping it.
        run(['docker', 'stop', '--time', '30', 'new-api'])
        api_stopped = True
        assert_idle()
        runner_changed = True
        run(['systemctl', 'stop', SERVICE])
        RUNNER.rename(backup)
        staged.rename(RUNNER)
        worker_env = transaction / 'worker.env'
        atomic_write(worker_env, ('CODEX_WORKER_IMAGE=' + manifest['worker_image_id'] + '\n' + ''.join(key + '=' + value + '\n' for key, value in sorted(manifest.get('runner_environment', {}).items()))).encode())
        atomic_write(DROPIN, ('[Service]\nEnvironmentFile=' + str(worker_env) + '\n').encode())
        config = json.loads(COMPOSE.read_text())
        config['services']['new-api']['image'] = manifest['api_image']
        atomic_write(COMPOSE, (json.dumps(config, indent=2) + '\n').encode())
        record['compose_after_sha256'] = digest(COMPOSE)
        run(['systemctl', 'daemon-reload'])
        run(['systemctl', 'start', SERVICE])
        compose_up()
        wait_health()
        if inspect('new-api')['Image'] != manifest['api_image_id']:
            raise RuntimeError('API did not start the candidate image')
        if other_containers() != record['other_containers']:
            raise RuntimeError('Other containers changed during the transaction')
        record['state'] = 'applied'
        atomic_write(transaction / 'record.private.json', json.dumps(record, indent=2).encode())
    except BaseException:
        if runner_changed:
            run(['docker', 'stop', '--time', '30', 'new-api'])
            restore(release, record)
            record['state'] = 'rolled_back_after_failure'
        elif api_stopped:
            run(['docker', 'start', 'new-api'])
            record['state'] = 'aborted_before_runner_change'
        atomic_write(transaction / 'record.private.json', json.dumps(record, indent=2).encode())
        raise
    print(json.dumps({'applied': True, 'release': manifest['release'], 'health': 'passed'}))


def rollback(release):
    manifest = load_release(release)
    record = json.loads((release / 'transaction/record.private.json').read_text())
    if record['state'] != 'applied' or inspect('new-api')['Image'] != manifest['api_image_id'] or digest(COMPOSE) != record['compose_after_sha256']:
        raise RuntimeError('Production changed after this release; refusing blind rollback')
    assert_idle()
    run(['docker', 'stop', '--time', '30', 'new-api'])
    try:
        assert_idle()
    except BaseException:
        run(['docker', 'start', 'new-api'])
        raise
    restore(release, record)
    record['state'] = 'rolled_back'
    atomic_write(release / 'transaction/record.private.json', json.dumps(record, indent=2).encode())
    print(json.dumps({'rolled_back': True, 'release': manifest['release']}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', nargs='?', choices=('preflight', 'apply', 'rollback'), default='preflight')
    parser.add_argument('--bundle', required=True, type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    if args.action == 'preflight':
        print(json.dumps({'preflight': 'passed', 'production_changed': False, **preflight(args.bundle.resolve())}, indent=2))
        return
    with open('/run/lock/new-api-codex-release.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        (apply if args.action == 'apply' else rollback)(args.bundle.resolve())


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never dump subprocess output, secrets, state contents, or private Compose.
        raise SystemExit(type(error).__name__ + ': ' + str(error))
