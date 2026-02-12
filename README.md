# Meatboy4500 RF Console (rf-console)

Mobile-first LAN UI for OP25 profile/status monitoring, talkgroup management, CSV imports, and service troubleshooting.

## Security model for controls

Control endpoints are protected by `ADMIN_TOKEN`.

- Backend control routes require `X-Admin-Token` (or basic/bearer token).
- Optional private network restriction is enabled by default (`CONTROL_PRIVATE_ONLY=1`).
- If backend cannot run privileged commands directly (normal in container), it can proxy to a host helper daemon.

## Important legal note

Do not scrape or redistribute proprietary/copyrighted radio datasets in violation of terms.

This project supports only user-supplied imports:
- CSV/TSV pasted/uploaded in UI
- JSON dropped into `/opt/stacks/rf-console/data/profiles`

No direct RadioReference scraping is implemented.

## Stack contents

- `docker-compose.yml`
  - `backend`: API + web UI
  - `icecast`: stream server
  - `streamer`: ffmpeg from ALSA loopback to Icecast
- Host services
  - `op25-supervisor.service`
  - optional `rf-control-helper.service` for privileged actions/logs

## Environment variables (backend)

Set in compose:

- `ADMIN_TOKEN` required for Controls API
- `CONTROL_PRIVATE_ONLY` default `1`
- `HOST_HELPER_URL` optional (example `http://HOST_IP:9911`)
- `HOST_HELPER_TOKEN` optional (defaults to `ADMIN_TOKEN`)

## Start stack

```bash
cd /opt/stacks/rf-console
docker compose up -d --build
```

UI: `http://<LAN-IP>:8080`

## OP25 supervisor install

```bash
sudo cp /opt/stacks/rf-console/op25/host/op25-supervisor.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now op25-supervisor.service
```

## Optional host helper (for Controls tab actions)

Use this if you want Start/Stop/Restart OP25, `modprobe`, `lsusb`, and host logs from UI.

1. Configure token/env:

```bash
cp /opt/stacks/rf-console/op25/host/rf-control-helper.env.example /opt/stacks/rf-console/op25/host/rf-control-helper.env
# edit ADMIN_TOKEN and optional bind/port/private flag
```

2. Install service:

```bash
sudo cp /opt/stacks/rf-console/op25/host/rf-control-helper.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rf-control-helper.service
sudo systemctl status rf-control-helper.service
```

3. Point backend to helper in compose env:

```yaml
ADMIN_TOKEN=your-token
HOST_HELPER_URL=http://<host-ip-or-helper-bind>:9911
HOST_HELPER_TOKEN=your-token
```

Notes:
- If helper binds to `127.0.0.1`, backend container cannot reach it directly.
- For container access, bind helper to reachable host IP and keep token/private-network protections enabled.

## UI layout

Tabs:
- `Health` (read-only): status lights + timestamps + OP25 decode fields
- `Controls`: profile switching, troubleshooting actions, logs panel
- `Talkgroups`: search/filter/pagination/favorites/bulk enable-disable
- `Imports`: separate CSV imports for sites and talkgroups
- `Audio`: embedded stream player

## Control actions (Controls tab)

Action buttons call `/api/control/action`:
- Start OP25
- Restart OP25
- Stop OP25
- Load ALSA loopback
- USB/SDR check
- Restart Streamer
- Restart Icecast
- Restart Backend (safe message; backend self-restart is not executed directly)

Log buttons call `/api/control/logs/:target`:
- OP25 supervisor journal
- streamer logs
- icecast logs

Response shape:

```json
{ "ok": true, "action": "restart-op25", "stdout": "...", "stderr": "", "exitCode": 0, "ts": "2026-02-12T00:00:00Z" }
```

## CSV import UX

Imports are split by type.

### A) Sites/Control Channels import
Endpoint:
- `POST /api/import/sites/:profile/preview`
- `POST /api/import/sites/:profile/save`

Required fields:
- `site_name`
- `control_freq`

Optional:
- `alt_freqs`, `nac`, `sysid`, `wacn`, `bandplan`

Template:

```csv
site_name,control_freq,alt_freqs,nac,sysid,wacn,bandplan
Phoenix Simulcast,771.10625,771.35625;770.85625,293,123,BEE00,P25 Auto
```

### B) Talkgroups import
Endpoint:
- `POST /api/import/talkgroups/:profile/preview`
- `POST /api/import/talkgroups/:profile/save`

Required fields:
- `tgid`
- `label`

Optional:
- `mode`, `encrypted`, `category`, `favorite`, `enabled`

Template:

```csv
tgid,label,mode,encrypted,category,favorite,enabled
1201,Dispatch A,D,false,dispatch,true,true
1202,TAC 2,T,false,tac,false,true
1299,Encrypted Ops,DE,true,ops,false,true
```

### JSON import from disk

- Place file in `/opt/stacks/rf-console/data/profiles/<PROFILE>.import.json`
- Use Controls/Imports button or API:
  - `POST /api/import/profile/:profile/from-json-file`

Expected JSON keys include `system.sites[]` and `talkgroups.entries[]`.

## Talkgroup filtering behavior

On talkgroup save/import:
- if any enabled `allow` entries exist: whitelist mode
- otherwise: blacklist mode (enabled deny list)

Stored in:
- `/opt/stacks/rf-console/data/profiles/<PROFILE>.talkgroups.json`
- `/opt/stacks/rf-console/data/runtime/<PROFILE>.filter.json`

Changes trigger OP25 reload request via `/opt/stacks/rf-console/data/runtime/reload-request.json`.

## Health checks

`GET /api/health` reports:
- backend
- host helper connectivity
- icecast `/stream`
- streamer source status
- op25 supervisor availability
- op25 lock/decode freshness
- ALSA loopback presence
- SDR presence/instructions

If helper is unavailable, health explicitly says host checks require helper.

## Troubleshooting

- No control actions work:
  - verify `ADMIN_TOKEN` in backend env
  - verify token entered in Controls tab
  - verify helper reachable when using privileged actions
- ALSA loopback missing:
  - `sudo modprobe snd-aloop`
  - `grep -i Loopback /proc/asound/cards`
- SDR missing:
  - install `rtl-sdr` package
  - add udev permissions for rtl device
  - reconnect dongle and run `lsusb`
