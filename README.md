# Meatboy4500 RF Console (rf-console)

Mobile-first LAN UI for OP25 status, controls, imports, talkgroup filtering, and audio.

## Reliability architecture (new)

### OP25 supervisor logging and failure visibility

`op25_supervisor.py` now launches OP25 child with:
- `stdout=subprocess.PIPE`
- `stderr=subprocess.STDOUT`
- `text=True`
- `bufsize=1`

No shell redirection is used.
No raw `sys.stderr`/`FileIO` manipulation is used.

Supervisor behavior:
- streams child output line-by-line
- appends full child output to:
  - `/opt/stacks/rf-console/data/runtime/op25-child.log`
- keeps rolling last ~100 lines and writes to status:
  - `lastErrorTail`
- on child exit writes to `/opt/stacks/rf-console/data/runtime/op25-status.json`:
  - `running=false`
  - `lastExitCode`
  - `lastErrorTail`
  - `lastStartCommand`
  - `timestamp`

### OP25 working directory

OP25 child is launched with explicit cwd:
- `/opt/src/op25/op25/gr-op25_repeater/apps`

Configured via supervisor argument `--op25-cwd` (default above).

### Active profile filename migration

Canonical file:
- `/opt/stacks/rf-console/data/runtime/active-profile.json`

Legacy file auto-migrated once if present:
- `active_profile.json` -> `active-profile.json`

## Security model for controls

Control endpoints require `ADMIN_TOKEN`.

- Send via `X-Admin-Token` header (UI stores token locally in browser).
- Optional RFC1918 restriction via `CONTROL_PRIVATE_ONLY=1` (default).

## Host helper (privileged commands)

Backend container cannot directly execute host `systemctl/modprobe/lsusb` reliably.
Use optional helper service:

- Script: `/opt/stacks/rf-console/op25/host/rf_control_helper.py`
- Unit: `/opt/stacks/rf-console/op25/host/rf-control-helper.service`

Install:

```bash
cp /opt/stacks/rf-console/op25/host/rf-control-helper.env.example /opt/stacks/rf-console/op25/host/rf-control-helper.env
# edit ADMIN_TOKEN, bind/port options
sudo cp /opt/stacks/rf-console/op25/host/rf-control-helper.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rf-control-helper.service
```

Backend env (compose):
- `ADMIN_TOKEN`
- `HOST_HELPER_URL`
- `HOST_HELPER_TOKEN`
- `CONTROL_PRIVATE_ONLY`

## API endpoints

### Status and health

- `GET /api/status`
  - includes OP25 runtime/failure fields (`lastExitCode`, `lastErrorTail`, `lastStartCommand`, `timestamp`)
- `GET /services`
  - service status for:
    - `op25-supervisor`
    - `rf-control-helper`
    - `icecast`
    - `streamer`
    - `rx.py`
- `GET /api/health`
  - compatibility/extended checks

### Profile validation

- `GET /api/validate-profile/:profile`

Validation enforces:
- `<PROFILE>.trunk.tsv` exists
- referenced `*.tags.tsv` files exist
- trunk file rows are quoted TSV format
- consistent column count
- returns first parse error clearly

UI blocks `Start OP25` and `Restart OP25` when validation fails.

### Controls and logs

- `POST /api/control/action`
- `GET /api/control/logs/:target`

Actions include:
- start/restart/stop OP25
- load ALSA loopback
- USB/SDR check
- restart streamer/icecast
- backend restart guidance

### Imports

- `POST /api/import/sites/:profile/preview`
- `POST /api/import/sites/:profile/save`
- `POST /api/import/talkgroups/:profile/preview`
- `POST /api/import/talkgroups/:profile/save`
- `POST /api/import/profile/:profile/from-json-file`
- `GET /api/import/templates`

CSV/TSV and JSON are user-supplied only. No scraping workflow is implemented.

## Trunk/Tags file convention

Enforced naming:
- `<PROFILE>.trunk.tsv` = OP25 trunk config
- `<PROFILE>.tags.tsv` = talkgroup labels

Importer/write paths now generate these files to keep profile config consistent.

## UI behavior

- Health status lights source from `GET /services`.
- Health tab shows OP25 error tail directly from `status.lastErrorTail`.
- Controls tab has explicit profile validation button and blocks invalid starts.

## Bring up

```bash
cd /opt/stacks/rf-console
docker compose up -d --build
```

UI:
- `http://<LAN-IP>:8080`

## Troubleshooting

- If OP25 fails to start:
  - open Health tab and review `OP25 Error Tail`
  - validate profile via Controls -> `Validate Active Profile`
  - check trunk/tags files exist and are quoted TSV
- If service lights show helper unavailable:
  - verify `rf-control-helper.service` active
  - verify backend `HOST_HELPER_URL` and token match
