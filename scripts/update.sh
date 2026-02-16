#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-}"

log() {
  printf '[update] %s\n' "$*"
}

warn() {
  printf '[update] WARN: %s\n' "$*" >&2
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    warn "Missing required command: $1"
    exit 1
  }
}

confirm() {
  local prompt="$1"
  local answer
  read -r -p "$prompt [y/N]: " answer
  [[ "$answer" =~ ^[Yy]$ ]]
}

need_cmd git
need_cmd docker

cd "$ROOT_DIR"

log "Current git status"
git status --porcelain

if [[ -n "$(git status --porcelain)" ]]; then
  if [[ -z "$MODE" ]]; then
    echo "Local changes detected. Choose a flow:"
    echo "  1) stash local changes"
    echo "  2) discard local changes"
    echo "  3) abort"
    read -r -p "Select [1-3]: " choice
    case "$choice" in
      1) MODE="--stash" ;;
      2) MODE="--discard" ;;
      *) MODE="--abort" ;;
    esac
  fi

  case "$MODE" in
    --stash)
      stash_msg="rf-console-update-$(date +%Y%m%d-%H%M%S)"
      log "Stashing changes as '$stash_msg'"
      git stash push -u -m "$stash_msg"
      ;;
    --discard)
      if confirm "This will discard tracked local edits (git reset --hard) and remove untracked files (git clean -fd). Continue?"; then
        git reset --hard
        git clean -fd
      else
        warn "Aborted by user"
        exit 1
      fi
      ;;
    *)
      warn "Aborting update because working tree is dirty"
      exit 1
      ;;
  esac
fi

log "Fetching and fast-forward pulling"
git fetch origin
git pull --ff-only

git_sha="$(git rev-parse --short=12 HEAD)"
log "Rebuilding OP25 with GIT_SHA=$git_sha"
docker compose down
GIT_SHA="$git_sha" docker compose build --no-cache op25
GIT_SHA="$git_sha" docker compose up -d --force-recreate --no-deps op25

log "Running container/image verification"
docker ps --filter name=rf-console-op25 --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
docker logs --tail 80 rf-console-op25

log "Update complete"
