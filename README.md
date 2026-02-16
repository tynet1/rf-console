# rf-console (Meatboy4500)

rf-console runs OP25 in Docker to avoid Debian 13 / Python 3.13 host runtime/systemd pipe instability.

## Legal note

- Decode/listen only to unencrypted traffic you are legally allowed to monitor.
- No RadioReference scraping is implemented.
- Imports only use user-provided CSV/TSV/JSON files.

## Audio pipeline (stable mode)

Current stable audio path is:

`OP25 -> ALSA loopback -> streamer (ffmpeg) -> Icecast -> browser/iPad`

Important:
- OP25 runner does **not** inject `-w http://...` into `rx.py`.
- `-w` remains Wireshark-only behavior if profile command explicitly uses it.
- Streamer is the component that pushes `/stream` to Icecast.

## Compose services

- `backend` (`:8080`)
- `icecast` (`:8000`)
- `op25` (`rf-console-op25`)
- `streamer` (`rf-console-streamer`)

`op25` mounts:
- `./data/profiles:/config:ro`
- `./data/runtime:/runtime`
- USB passthrough: `/dev/bus/usb:/dev/bus/usb`

`backend` networking for host helper:
- `extra_hosts: host.docker.internal:host-gateway`
- default helper URL: `http://host.docker.internal:9911`

## Bootstrap (idempotent)

Run once on a clean install (or rerun any time):

```bash
cd /opt/stacks/rf-console
./scripts/bootstrap.sh
```

What it does:
- creates/updates `.env`
- generates `ADMIN_TOKEN` if missing
- sets `HOST_HELPER_URL=http://host.docker.internal:9911`
- sets `HOST_HELPER_TOKEN` to match `ADMIN_TOKEN`
- writes `op25/host/rf-control-helper.env` with `HELPER_BIND=0.0.0.0`
- installs/enables/restarts `rf-control-helper.service`
- starts/rebuilds backend and tests helper reachability from inside the backend container

Expected UI result:
- Controls tab shows `helperConfigured=true`
- Controls tab shows `helperReachable=true`

## OP25 runner

File:
- `op25/docker/op25_container_runner.py`

Runner behavior:
- reads active profile from `/runtime/active-profile.json` (fallback `/runtime/active_profile.json`)
- discovers `rx.py` by checking, in order:
  1. `/op25/op25/gr-op25_repeater/apps/rx.py`
  2. `/opt/op25/op25/gr-op25_repeater/apps/rx.py`
  3. `/opt/src/op25/op25/gr-op25_repeater/apps/rx.py`
- if not found, exits once with a clear error listing checked paths
- normalizes trunk file to `/config/<PROFILE>.trunk.tsv` (fallback legacy `/config/<PROFILE>.tsv`)
- ensures `-O` exists and defaults to `OP25_AUDIO_OUT` (`plughw:Loopback,0,0`)
- removes accidental legacy URL argument after `-w` if present
- does not internally restart-loop; exits with child exit code
- prints image revision from `OP25_IMAGE_REVISION` (built from `GIT_SHA`)

## API highlights

- `GET /services`
- `GET /api/validate-profile/:profile`
- `GET /api/validate-profile/:profile?createMissingTags=1`
- `POST /api/profiles/switch`
- `POST /api/op25/restart`
- `GET /api/op25/logs-tail`
- `GET /api/debug/helper` (requires admin token)
- `POST /api/profiles/:profile/tags/init` (requires admin token)

## Git workflow (safe pulls)

Recommended CLI flow before push/pull:

```bash
git fetch origin
git status
git pull --ff-only
```

If local commits diverge and you want to reset to remote main:

```bash
git fetch origin
git reset --hard origin/main
```

Use feature branches for changes and avoid force-push unless you explicitly need to rewrite your own branch history.

## Safe update helper

Use `scripts/update.sh` on Meatboy4500:

```bash
cd /opt/stacks/rf-console
./scripts/update.sh
```

Behavior:
- shows dirty state (`git status --porcelain`)
- if dirty: choose stash or discard flow
- runs `git fetch origin && git pull --ff-only`
- rebuilds/recreates OP25 with fresh image metadata (`GIT_SHA`)
- prints running container/image/status plus OP25 log tail

## Hard reset (Meatboy4500)

```bash
cd /opt/stacks/rf-console
git reset --hard
git clean -fd
```

```bash
sudo modprobe snd-aloop
```

```bash
docker compose down
docker compose build --no-cache op25 streamer backend
docker compose up -d --force-recreate
```

Verify:

```bash
docker compose ps
docker logs --tail 120 rf-console-op25
docker logs --tail 120 rf-console-streamer
curl http://localhost:8000/stream -o /dev/null
```

To confirm which commit is running in OP25:

```bash
docker logs --tail 120 rf-console-op25 | grep -E '\\[op25-runner\\] revision='
docker inspect rf-console-op25 --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}'
```

## Troubleshooting

### OP25 restart-loop

Check runner diagnostics:

```bash
docker logs --tail 120 rf-console-op25
```

Expected diagnostics include:
- selected profile
- `/config` and `/runtime` existence summary
- selected `apps_dir` and `rx_py`
- final command line

If `rx.py` missing, error should list all checked locations and exit non-zero.

If helper is unreachable from backend:

```bash
curl -H "x-admin-token: $ADMIN_TOKEN" http://localhost:8080/api/debug/helper
```

Verify helper bind:

```bash
sudo systemctl status rf-control-helper.service --no-pager
ss -ltnp | grep 9911
```

### No RTL dongle detected

```bash
lsusb | grep -Ei 'rtl|realtek'
```

Then confirm compose includes `/dev/bus/usb:/dev/bus/usb`.

### No audio

```bash
docker logs --tail 120 rf-console-streamer
docker logs --tail 120 rf-console-icecast
```

Confirm iPad can open:
- `http://<meatboy4500-ip>:8000/stream`

## Acceptance checklist

1. `docker compose ps` shows `rf-console-op25` as `Up` (not restarting).
2. `docker logs rf-console-op25` does not show usage spam from invalid `-w http://...` args.
3. `rf-console-streamer` is pushing to Icecast `/stream`.
4. UI shows OP25 service status and log tail.
5. iPad plays `http://<meatboy4500-ip>:8000/stream`.
