#!/usr/bin/env bash
# The application is the only container attached to this private control bridge.
set -euo pipefail
task_network=new-api-codex-control
if ! docker network inspect "$task_network" >/dev/null 2>&1; then
  docker network create --driver bridge --internal --subnet 172.31.241.0/28 \
    --label new-api.codex.control=true \
    --opt com.docker.network.bridge.name=br-codex-ctrl "$task_network" >/dev/null
fi
task_actual=$(docker network inspect --format '{{.Internal}}|{{(index .IPAM.Config 0).Subnet}}|{{index .Options "com.docker.network.bridge.name"}}|{{index .Labels "new-api.codex.control"}}' "$task_network")
test "$task_actual" = 'true|172.31.241.0/28|br-codex-ctrl|true'
iptables -w -C INPUT -i br-codex-ctrl -s 172.31.241.0/28 -d 172.31.241.1 -p tcp --dport 7310 -j ACCEPT 2>/dev/null || \
  iptables -w -I INPUT 1 -i br-codex-ctrl -s 172.31.241.0/28 -d 172.31.241.1 -p tcp --dport 7310 -j ACCEPT
