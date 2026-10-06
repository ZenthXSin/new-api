#!/usr/bin/env bash
# Run as root on the Docker host. These rules touch only the dedicated Codex bridge.
# Persist/reapply after Docker/firewall restart before starting workspaces.
set -euo pipefail
task_network=new-api-codex-workers
task_subnet=172.31.240.0/24
task_bridge=br-codex-work
if ! docker network inspect "$task_network" >/dev/null 2>&1; then
  docker network create --driver bridge --subnet "$task_subnet" \
    --label new-api.codex.managed=true \
    --opt com.docker.network.bridge.name="$task_bridge" \
    --opt com.docker.network.bridge.enable_icc=false \
    "$task_network" >/dev/null
fi
task_actual=$(docker network inspect --format '{{(index .IPAM.Config 0).Subnet}}|{{index .Options "com.docker.network.bridge.name"}}|{{index .Labels "new-api.codex.managed"}}|{{.EnableIPv6}}' "$task_network")
test "$task_actual" = "$task_subnet|$task_bridge|true|false"

iptables -w -N NEWAPI_CODEX_OUT 2>/dev/null || true
iptables -w -F NEWAPI_CODEX_OUT
for task_destination in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/3; do
  iptables -w -A NEWAPI_CODEX_OUT -d "$task_destination" -j REJECT
done
iptables -w -A NEWAPI_CODEX_OUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
for task_resolver in 1.1.1.1 8.8.8.8; do
  iptables -w -A NEWAPI_CODEX_OUT -d "$task_resolver" -p udp --dport 53 -j ACCEPT
  iptables -w -A NEWAPI_CODEX_OUT -d "$task_resolver" -p tcp --dport 53 -j ACCEPT
done
iptables -w -A NEWAPI_CODEX_OUT -p tcp -m multiport --dports 80,443 -j ACCEPT
iptables -w -A NEWAPI_CODEX_OUT -j REJECT
iptables -w -C DOCKER-USER -i "$task_bridge" -j NEWAPI_CODEX_OUT 2>/dev/null || iptables -w -I DOCKER-USER 1 -i "$task_bridge" -j NEWAPI_CODEX_OUT

# Same-host model routing may use the public HTTPS virtual host. Host SSH, runner,
# databases, Docker TCP and all other host services remain inaccessible.
iptables -w -N NEWAPI_CODEX_HOST 2>/dev/null || true
iptables -w -F NEWAPI_CODEX_HOST
iptables -w -A NEWAPI_CODEX_HOST -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -w -A NEWAPI_CODEX_HOST -p tcp --dport 443 -j ACCEPT
iptables -w -A NEWAPI_CODEX_HOST -j REJECT
iptables -w -C INPUT -i "$task_bridge" -j NEWAPI_CODEX_HOST 2>/dev/null || iptables -w -I INPUT 1 -i "$task_bridge" -j NEWAPI_CODEX_HOST
docker network inspect --format '{{.Name}} {{(index .IPAM.Config 0).Subnet}}' "$task_network"
