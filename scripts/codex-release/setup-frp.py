#!/usr/bin/env python3
"""Install the owned Codex FRP service without restarting API/runner/workspaces."""
import argparse
import ipaddress
import json
import os
import re
from pathlib import Path
import secrets
import shutil
import subprocess


def run(args):
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError('FRP setup command failed: ' + ' '.join(args[:2]))
    return result.stdout.strip()


def write(path, content, mode=0o600):
    temporary = path.with_name(path.name + '.next')
    temporary.write_text(content)
    temporary.chmod(mode)
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--public-host', required=True)
    parser.add_argument('--vendor', type=Path, default=Path('/opt/new-api-frp'))
    args = parser.parse_args()
    ipaddress.IPv4Address(args.public_host)
    owned_pid = subprocess.run(['systemctl', 'show', 'new-api-codex-frps.service', '--property=MainPID', '--value'], capture_output=True, text=True).stdout.strip()
    for listener in run(['ss', '-H', '-ltnp']).splitlines():
        fields = listener.split()
        port = int(fields[3].rsplit(':', 1)[-1])
        if 30000 <= port <= 39999 and owned_pid not in re.findall(r'pid=(\d+)', listener):
            raise RuntimeError(f'Public port pool conflicts with an existing listener on {port}')
    os.umask(0o077)
    target = Path('/opt/new-api-codex-frp')
    settings = Path('/etc/new-api-codex-frp')
    target.mkdir(mode=0o755, exist_ok=True)
    settings.mkdir(mode=0o700, exist_ok=True)
    target.chmod(0o755)
    settings.chmod(0o700)
    for name in ['frpc', 'frps', 'LICENSE']:
        destination = target / name
        if destination.exists() and destination.read_bytes() != (args.vendor / name).read_bytes():
            raise RuntimeError('Existing Codex FRP binary differs; review before replacing')
        if not destination.exists():
            shutil.copy2(args.vendor / name, destination)
        destination.chmod(0o644 if name == 'LICENSE' else 0o755)
    if run([str(target / 'frpc'), '--version']) != '0.71.0' or run([str(target / 'frps'), '--version']) != '0.71.0':
        raise RuntimeError('FRP 0.71.0 is required')
    token_file = settings / 'token'
    if not token_file.exists():
        write(token_file, secrets.token_hex(32) + '\n')
    token = token_file.read_text().strip()
    if len(token) != 64 or any(c not in '0123456789abcdef' for c in token):
        raise RuntimeError('Invalid existing FRP credential')
    token_file.chmod(0o600)
    configuration = {'bindAddr': '172.31.240.1', 'bindPort': 7430, 'proxyBindAddr': args.public_host, 'maxPortsPerClient': 10, 'allowPorts': [{'start': 30000, 'end': 39999}], 'auth': {'method': 'token', 'token': token, 'additionalScopes': ['HeartBeats', 'NewWorkConns']}, 'transport': {'tls': {'force': True}}, 'log': {'to': 'console', 'level': 'warn'}, 'detailedErrorsToClient': False}
    write(settings / 'frps.json', json.dumps(configuration, indent=2) + '\n')
    run([str(target / 'frps'), 'verify', '-c', str(settings / 'frps.json')])
    write(settings / 'manager.json', json.dumps({'serverHost': '172.31.240.1', 'serverPort': 7430, 'adminPort': 7401, 'publicHost': args.public_host, 'publicBindAddr': args.public_host, 'portStart': 30000, 'portEnd': 39999, 'frpc': str(target / 'frpc'), 'tokenFile': str(token_file)}, indent=2) + '\n')
    network = '''#!/bin/bash
set -euo pipefail
iptables -w -N NEWAPI_CODEX_FRP 2>/dev/null || true
if ! iptables -w -C NEWAPI_CODEX_FRP -p tcp -j REJECT --reject-with tcp-reset 2>/dev/null; then
  iptables -w -A NEWAPI_CODEX_FRP -p tcp -j REJECT --reject-with tcp-reset
fi
iptables -w -C INPUT -d PUBLIC_IPV4 -p tcp --dport 30000:39999 -j NEWAPI_CODEX_FRP 2>/dev/null || iptables -w -I INPUT 1 -d PUBLIC_IPV4 -p tcp --dport 30000:39999 -j NEWAPI_CODEX_FRP
while iptables -w -C INPUT -p tcp --dport 30000:39999 -j NEWAPI_CODEX_FRP 2>/dev/null; do
  iptables -w -D INPUT -p tcp --dport 30000:39999 -j NEWAPI_CODEX_FRP
done
iptables -w -C NEWAPI_CODEX_HOST -s 172.31.240.0/24 -d 172.31.240.1 -p tcp --dport 7430 -j ACCEPT 2>/dev/null || iptables -w -I NEWAPI_CODEX_HOST 1 -s 172.31.240.0/24 -d 172.31.240.1 -p tcp --dport 7430 -j ACCEPT
'''
    write(target / 'setup-network.sh', network.replace('PUBLIC_IPV4', args.public_host), 0o755)
    unit = '''[Unit]
Description=New API Codex FRP server
After=network-online.target new-api-codex-network.service
Wants=network-online.target new-api-codex-network.service

[Service]
Type=exec
User=root
ExecStartPre=/opt/new-api-codex-frp/setup-network.sh
ExecStart=/opt/new-api-codex-frp/frps -c /etc/new-api-codex-frp/frps.json
Restart=on-failure
RestartSec=3
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
NoNewPrivileges=yes
MemoryMax=256M
TasksMax=128
LimitNOFILE=16384

[Install]
WantedBy=multi-user.target
'''
    write(Path('/etc/systemd/system/new-api-codex-frps.service'), unit, 0o644)
    dropin = Path('/etc/systemd/system/new-api-codex.service.d/95-frp.conf')
    dropin.parent.mkdir(parents=True, exist_ok=True)
    write(dropin, '[Unit]\nAfter=new-api-codex-frps.service\nWants=new-api-codex-frps.service\n\n[Service]\nEnvironment=CODEX_FRP_CONFIG_FILE=/etc/new-api-codex-frp/manager.json\n', 0o644)
    run(['systemctl', 'daemon-reload'])
    run(['systemctl', 'enable', '--now', 'new-api-codex-frps.service'])
    assert run(['systemctl', 'is-active', 'new-api-codex-frps.service']) == 'active'
    print(json.dumps({'frp_service': 'active', 'version': '0.71.0', 'per_container_ports': 10, 'public_port_pool': [30000, 39999], 'runner_restarted': False}))


if __name__ == '__main__':
    main()
