# rf-console (Meatboy4500)

rf-console now runs OP25 in Docker (direct to Icecast) to avoid Debian 13 / Python 3.13 host runtime issues (systemd pipe + stdio detach crashes).

## Legal note

- Decode/listen only to unencrypted traffic that is legal to monitor in your jurisdiction.
- No RadioReference scraping is implemented.
- Imports only use user-provided CSV/TSV/JSON files.

## Services

`docker-compose.yml` includes:
- `backend` (UI + API on `:8080`)
- `icecast` (stream on `:8000`)
- `op25` (`rf-console-op25`) direct source to Icecast
- `streamer` (legacy optional ALSA/ffmpeg path; not required for OP25 direct mode)

## Why Dockerized OP25

Host/systemd OP25 on Debian 13 can fail with Python 3.13 stdio/pipe behavior. Moving OP25 to a pinned container runtime avoids that host mismatch.

## OP25 runtime files

- Active profile: `/opt/stacks/rf-console/data/runtime/active-profile.json`
  - fallback supported: `active_profile.json`
- Profiles: `/opt/stacks/rf-console/data/profiles`
  - `<PROFILE>.profile.json`
  - `<PROFILE>.trunk.tsv`
  - `<PROFILE>.tags.tsv`

## OP25 container runner

File:
- `/opt/stacks/rf-console/op25/docker/op25_container_runner.py`

Behavior:
- reads active profile from runtime JSON
- reads profile command
- rewrites host paths to `/config`
- enforces trunk path `/config/<PROFILE>.trunk.tsv`
- strips ALSA output flags (`-O ...`)
- enforces direct Icecast stream: `-w http://icecast:8000/stream`
- validates `rx.py` exists in container before launch
- logs resolved command to container logs

## Deploy on Meatboy4500

```bash
cd /opt/stacks/rf-console
docker compose up -d --build
docker compose ps
```

## Health / controls API

- `GET /services`
  - backend, icecast, streamer, op25 container state (status, uptime, lastExitCode)
- `GET /api/validate-profile/:profile`
- `POST /api/profiles/switch`
  - validates profile files
  - writes active profile
  - restarts `rf-console-op25`
- `POST /api/op25/restart`
- `GET /api/op25/logs-tail`

## UI behavior

- Status lights use `/services`
- Controls tab has `Restart OP25`
- Health tab shows OP25 logs tail and actionable hint if OP25 is down

## Backend Docker control requirements

Backend needs Docker CLI and socket access:
- backend image installs `docker.io` client
- compose mounts `/var/run/docker.sock:/var/run/docker.sock`

If Docker is unavailable in backend container, endpoints return actionable errors.

## Troubleshooting

### 1) No RTL-SDR device found

```bash
lsusb | grep -Ei 'rtl|realtek'
```

Then verify compose device mapping:
- `/dev/bus/usb:/dev/bus/usb`

If needed, adjust udev rules/permissions on host.

### 2) OP25 not starting

```bash
docker logs --tail 200 rf-console-op25
```

Common causes:
- missing `/config/<PROFILE>.trunk.tsv`
- missing `/config/<PROFILE>.tags.tsv`
- invalid profile command
- `rx.py` path missing in image

### Runner path-resolution verification (Meatboy4500)

Use this checklist after runner updates:

```bash
cd /opt/stacks/rf-console
docker compose build --no-cache op25
docker compose up -d --force-recreate op25
docker logs --tail 120 rf-console-op25
```

Expected startup logs include:
- `[op25-runner] apps_dir=/op25/op25/gr-op25_repeater/apps` (on current image)
- `[op25-runner] rx_py=/op25/op25/gr-op25_repeater/apps/rx.py`
- `[op25-runner] command=... -w http://icecast:8000/stream ...`

If `rx.py` is not found, runner exits cleanly with checked paths listed, for example:
- `ERROR: rx.py not found. checked: /op25/.../rx.py, /opt/op25/.../rx.py, /opt/src/op25/.../rx.py`

### 3) No audio in player

- verify Icecast is up:

```bash
docker logs --tail 200 rf-console-icecast
```

- verify OP25 uses `-w http://icecast:8000/stream` (runner enforces this)
- test stream URL from iPad browser:
  - `http://<meatboy-ip>:8000/stream`

### 4) Check OP25 service state via API

```bash
curl -s http://<meatboy-ip>:8080/services | jq
curl -s http://<meatboy-ip>:8080/api/op25/logs-tail | jq
```

## Local acceptance checklist

1. `docker compose up -d --build` succeeds.
2. `docker compose ps` shows `rf-console-op25` running.
3. `docker logs rf-console-op25` shows OP25 startup + tuned command.
4. UI shows OP25 service state and logs tail.
5. Switch profile in UI and OP25 restarts cleanly.
6. iPad plays `http://<meatboy-ip>:8000/stream`.
