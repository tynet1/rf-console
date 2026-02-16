#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
HELPER_ENV_FILE="$ROOT_DIR/op25/host/rf-control-helper.env"
HELPER_SERVICE_NAME="rf-control-helper.service"
HELPER_SERVICE_SRC="$ROOT_DIR/op25/host/rf-control-helper.service"
HELPER_SERVICE_DST="/etc/systemd/system/$HELPER_SERVICE_NAME"

log() {
  printf '[bootstrap] %s\n' "$*"
}

warn() {
  printf '[bootstrap] WARN: %s\n' "$*" >&2
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    warn "Missing required command: $1"
    exit 1
  }
}

run_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

random_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  elif command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
  else
    head -c 48 /dev/urandom | base64 | tr -d '\n' | cut -c1-64
  fi
}

read_env_value() {
  local key="$1"
  local file="$2"
  [[ -f "$file" ]] || return 0
  awk -F= -v k="$key" '$1==k {sub(/^[^=]*=/, "", $0); print $0; exit}' "$file"
}

upsert_env_value() {
  local key="$1"
  local value="$2"
  local file="$3"

  if [[ ! -f "$file" ]]; then
    printf '%s=%s\n' "$key" "$value" >"$file"
    return
  fi

  if grep -qE "^${key}=" "$file"; then
    local tmp
    tmp="$(mktemp)"
    awk -v k="$key" -v v="$value" -F= 'BEGIN{done=0} {
      if (!done && $1==k) {print k"="v; done=1; next}
      print
    } END {if (!done) print k"="v}' "$file" >"$tmp"
    mv "$tmp" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >>"$file"
  fi
}

need_cmd git
need_cmd docker
need_cmd systemctl

mkdir -p "$ROOT_DIR/data/runtime"
mkdir -p "$ROOT_DIR/data/profiles"

if [[ ! -f "$ENV_FILE" ]]; then
  log "Creating $ENV_FILE"
  cat >"$ENV_FILE" <<'ENVEOF'
# rf-console local environment
ADMIN_TOKEN=
HOST_HELPER_URL=http://host.docker.internal:9911
HOST_HELPER_TOKEN=
CONTROL_PRIVATE_ONLY=1
ENVEOF
fi

admin_token="$(read_env_value ADMIN_TOKEN "$ENV_FILE")"
if [[ -z "$admin_token" || "$admin_token" == "change-me" ]]; then
  admin_token="$(random_token)"
  log "Generated new ADMIN_TOKEN"
fi

upsert_env_value ADMIN_TOKEN "$admin_token" "$ENV_FILE"
upsert_env_value HOST_HELPER_URL "http://host.docker.internal:9911" "$ENV_FILE"
upsert_env_value HOST_HELPER_TOKEN "$admin_token" "$ENV_FILE"

chmod 600 "$ENV_FILE" || true

log "Writing helper env: $HELPER_ENV_FILE"
cat >"$HELPER_ENV_FILE" <<EOF_HELPER
ADMIN_TOKEN=$admin_token
HELPER_BIND=0.0.0.0
HELPER_PORT=9911
OP25_SERVICE=op25-supervisor.service
PRIVATE_ONLY_FLAG=--private-only
EOF_HELPER

if [[ -f "$HELPER_SERVICE_SRC" ]]; then
  if [[ ! -f "$HELPER_SERVICE_DST" ]] || ! cmp -s "$HELPER_SERVICE_SRC" "$HELPER_SERVICE_DST"; then
    log "Installing $HELPER_SERVICE_NAME unit"
    run_root install -m 0644 "$HELPER_SERVICE_SRC" "$HELPER_SERVICE_DST"
  fi
else
  warn "Helper service source missing: $HELPER_SERVICE_SRC"
fi

log "Reloading systemd and enabling helper"
run_root systemctl daemon-reload
run_root systemctl enable --now "$HELPER_SERVICE_NAME"
run_root systemctl restart "$HELPER_SERVICE_NAME"

log "Bringing up backend container"
(
  cd "$ROOT_DIR"
  docker compose up -d --build backend
)

log "Status summary"
run_root systemctl --no-pager --full status "$HELPER_SERVICE_NAME" | sed -n '1,18p' || true
(
  cd "$ROOT_DIR"
  docker compose ps backend
)

log "Helper connectivity test from backend container"
set +e
(
  cd "$ROOT_DIR"
  docker compose exec -T backend node -e '
const url = process.env.HOST_HELPER_URL || "http://host.docker.internal:9911";
const token = process.env.HOST_HELPER_TOKEN || process.env.ADMIN_TOKEN || "";
const endpoint = `${url.replace(/\/$/, "")}/health`;
fetch(endpoint, { headers: { "x-admin-token": token } })
  .then(async (res) => {
    const body = await res.text();
    console.log(JSON.stringify({ ok: res.ok, status: res.status, endpoint, body }, null, 2));
    process.exit(res.ok ? 0 : 1);
  })
  .catch((err) => {
    console.error(JSON.stringify({ ok: false, endpoint, error: err.message }, null, 2));
    process.exit(1);
  });
'
)
connectivity_rc=$?
set -e

if [[ $connectivity_rc -ne 0 ]]; then
  warn "Helper connectivity test failed. Check helper bind/token and docker networking."
else
  log "Helper connectivity OK"
fi

log "Bootstrap complete"
