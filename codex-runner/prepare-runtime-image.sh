#!/usr/bin/env bash
set -euo pipefail
task_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
task_vendor=${1:?Pass the installed @openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl directory}
test -f "$task_vendor/bin/codex"
test -f "$task_vendor/bin/codex-code-mode-host"
mkdir -p "$task_root/runtime-vendor"
install -m 0755 "$task_vendor/bin/codex" "$task_root/runtime-vendor/codex"
install -m 0755 "$task_vendor/bin/codex-code-mode-host" "$task_root/runtime-vendor/codex-code-mode-host"
"$task_root/runtime-vendor/codex" --version
sha256sum "$task_root/runtime-vendor/codex" "$task_root/runtime-vendor/codex-code-mode-host"
