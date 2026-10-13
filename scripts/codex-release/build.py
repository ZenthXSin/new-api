#!/usr/bin/env python3
"""Build a frozen, versioned API + host runner + worker release; never deploy."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
from datetime import datetime, timezone


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def run(args, **kwargs):
    subprocess.run(args, check=True, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', required=True)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--api-base-image', default='debian:bookworm-slim@sha256:f06537653ac770703bc45b4b113475bd402f451e85223f0f2837acbf89ab020a')
    parser.add_argument('--worker-base-image', help='Optional compatible prebuilt worker image; by default build Dockerfile.workspace')
    parser.add_argument('--max-active', type=int)
    parser.add_argument('--efforts', default='low,medium,high,xhigh,max,ultra')
    parser.add_argument('--memory-mb', type=int)
    args = parser.parse_args()
    if not re.fullmatch(r'[a-z0-9][a-z0-9.-]{0,63}', args.release):
        parser.error('release must be a short lowercase image-tag identifier')
    runner_environment = {}
    if args.max_active is not None:
        if args.max_active < 1 or args.max_active > 8:
            parser.error('max-active must be between 1 and 8')
        runner_environment['CODEX_MAX_ACTIVE'] = str(args.max_active)
    if args.memory_mb is not None:
        if args.memory_mb < 256 or args.memory_mb > 1048576:
            parser.error('memory-mb must be between 256 and 1048576')
        runner_environment['CODEX_WORKER_MEMORY_MB'] = str(args.memory_mb)
    if args.efforts:
        values = args.efforts.split(',')
        if any(value not in {'low', 'medium', 'high', 'xhigh', 'max', 'ultra'} for value in values):
            parser.error('unsupported reasoning effort')
        runner_environment['CODEX_EFFORTS'] = ','.join(dict.fromkeys(values))
    os.umask(0o077)
    output = args.output.resolve()
    source = args.source.resolve()
    if output == source or source in output.parents:
        raise RuntimeError('Release output must be outside the source tree')
    output.mkdir(parents=True, exist_ok=False)
    snapshot = output / 'source'
    excluded = {'.git', 'node_modules', 'dist', '__pycache__', '.cache', '.bun', 'bin'}
    shutil.copytree(source, snapshot, ignore=lambda path, names: [n for n in names if n in excluded])
    # The build runs from a frozen source snapshot, not agents' mutable worktree.
    dependencies = source / 'web/node_modules'
    if not dependencies.exists():
        raise RuntimeError('Install web dependencies before building a release')
    (snapshot / 'web/node_modules').symlink_to(dependencies.resolve(), target_is_directory=True)
    environment = os.environ.copy()
    environment.update({'DISABLE_ESLINT_PLUGIN': 'true', 'VITE_REACT_APP_VERSION': (snapshot / 'VERSION').read_text().strip()})
    run(['bun', 'run', 'build'], cwd=snapshot / 'web', env=environment)
    binary = output / 'api/new-api'
    binary.parent.mkdir()
    environment.update({'CGO_ENABLED': '0', 'GOOS': 'linux', 'GOARCH': 'amd64', 'GOWORK': 'off', 'GOMAXPROCS': '2'})
    version = (snapshot / 'VERSION').read_text().strip() + '-codex-' + args.release
    run(['go', 'build', '-trimpath', '-ldflags', '-s -w -X github.com/QuantumNous/new-api/common.Version=' + version, '-o', str(binary), '.'], cwd=snapshot, env=environment)
    for name in ('LICENSE', 'NOTICE', 'THIRD-PARTY-LICENSES.md'):
        shutil.copy2(snapshot / name, binary.parent / name)
    (binary.parent / 'Dockerfile').write_text('FROM ' + args.api_base_image + '''
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tzdata libasan8 wget && rm -rf /var/lib/apt/lists/* && update-ca-certificates
COPY new-api /new-api
COPY LICENSE NOTICE THIRD-PARTY-LICENSES.md /licenses/
WORKDIR /data
EXPOSE 3000
ENTRYPOINT ["/new-api"]
''')
    api_image = 'new-api:codex-web-' + args.release
    worker_image = 'new-api:codex-worker-' + args.release
    run(['docker', 'build', '--label', 'new-api.codex.release=' + args.release, '-t', api_image, str(binary.parent)])
    worker_dockerfile = output / 'Dockerfile.worker'
    if args.worker_base_image:
        worker_dockerfile.write_text('FROM ' + args.worker_base_image + '\nCOPY --chmod=755 runtime-vendor/codex /usr/local/bin/codex\nCOPY --chmod=755 runtime-vendor/codex-code-mode-host /usr/local/bin/codex-code-mode-host\nCOPY --chmod=755 runtime-vendor/gh /usr/local/bin/gh\nCOPY --chmod=644 workspace-git.py workspace-process.py migrate-codex-home.py /opt/new-api-codex/\n')
    else:
        worker_dockerfile.write_text((snapshot / 'codex-runner/Dockerfile.workspace').read_text())
    run(['docker', 'build', '--label', 'new-api.codex.release=' + args.release, '-t', worker_image, '-f', str(worker_dockerfile), str(snapshot / 'codex-runner')])
    archive = output / 'runner.tar.gz'
    with tarfile.open(archive, 'w:gz') as bundle:
        for entry in sorted((snapshot / 'codex-runner').iterdir()):
            if entry.name not in {'runtime-vendor', 'test', '__pycache__'} and entry.is_file():
                bundle.add(entry, arcname=entry.name)
    source_hashes = {}
    for entry in sorted(snapshot.rglob('*')):
        if entry.is_file() and 'node_modules' not in entry.parts and 'dist' not in entry.parts:
            source_hashes[str(entry.relative_to(snapshot))] = digest(entry)
    (output / 'source-sha256.json').write_text(json.dumps(source_hashes, indent=2) + '\n')
    manifest = {'runner_environment': runner_environment, 'release': args.release, 'created_at': datetime.now(timezone.utc).isoformat(), 'api_image': api_image, 'worker_image': worker_image, 'runner_archive': archive.name, 'runner_sha256': digest(archive), 'source_manifest_sha256': digest(output / 'source-sha256.json'), 'api_binary_sha256': digest(binary), 'version': version}
    for kind in ('api', 'worker'):
        manifest[kind + '_image_id'] = subprocess.check_output(['docker', 'image', 'inspect', '--format', '{{.Id}}', manifest[kind + '_image']], text=True).strip()
    (output / 'release.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'built': True, 'manifest': str(output / 'release.json'), 'production_changed': False}))


if __name__ == '__main__':
    main()
