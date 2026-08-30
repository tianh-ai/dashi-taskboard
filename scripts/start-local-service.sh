#!/bin/zsh

set -euo pipefail

agent_id="${CODEX_TASKBOARD_WECOM_AGENT_ID:-}"
if [[ -z "$agent_id" ]]; then
  print -u2 'CODEX_TASKBOARD_WECOM_AGENT_ID is required'
  exit 1
fi

secret_account="${CODEX_TASKBOARD_WECOM_SECRET_KEYCHAIN_ACCOUNT:-CODEX_TASKBOARD_WECOM_SECRET_${agent_id}}"
export CODEX_TASKBOARD_WECOM_SECRET="$(/usr/bin/security find-generic-password \
  -s dashi-taskboard \
  -a "$secret_account" \
  -w)"

service_secret_account="${CODEX_TASKBOARD_SERVICE_SECRET_KEYCHAIN_ACCOUNT:-CODEX_TASKBOARD_SERVICE_SECRET_${agent_id}}"
if service_secret="$(/usr/bin/security find-generic-password \
  -s dashi-taskboard \
  -a "$service_secret_account" \
  -w 2>/dev/null)"; then
  export CODEX_TASKBOARD_SERVICE_SECRET="$service_secret"
fi

exec /opt/homebrew/bin/node server/index.mjs
