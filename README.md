# Meatboy4500 RF Console

iPad-friendly local web GUI for OP25 profile switching, status/health visibility, legal user-driven data import, talkgroup filtering, and Icecast audio playback.

## What this stack includes

- `docker-compose.yml`
  - `backend`: Node/Express REST API + mobile web UI
  - `icecast`: audio stream endpoint
  - `streamer`: ffmpeg service that reads ALSA loopback and pushes MP3 to Icecast `/stream`
- Host-side OP25 supervisor (`systemd`)
  - Watches active profile changes and reload requests
  - Restarts OP25 on profile switch or talkgroup/filter changes
  - Publishes decode/status metadata for the UI/API

## Important legal note

Do not scrape or redistribute proprietary/copyrighted frequency or talkgroup datasets in ways that violate terms of service.

This project intentionally supports **user-supplied imports**:
- CSV pasted/uploaded in UI
- JSON dropped into `/opt/stacks/rf-console/data/profiles`

No direct scraping workflow is provided.

## Paths

- Compose stack: `/opt/stacks/rf-console/docker-compose.yml`
- Backend: `/opt/stacks/rf-console/backend`
- OP25 service unit: `/opt/stacks/rf-console/op25/host/op25-supervisor.service`
- Profiles: `/opt/stacks/rf-console/data/profiles`
- Runtime state: `/opt/stacks/rf-console/data/runtime`

## Quick install (Debian 13)

1. Copy folder to `/opt/stacks/rf-console`
2. Ensure Docker + Compose are installed
3. Ensure Python 3 exists on host
4. Install OP25 on host and verify `rx.py` path in profile command arrays
5. Load ALSA loopback:

```bash
sudo modprobe snd-aloop
echo snd-aloop | sudo tee /etc/modules-load.d/snd-aloop.conf
aplay -l | grep -i loopback
```

## Start stack

```bash
cd /opt/stacks/rf-console
docker compose up -d --build
```

- UI: `http://<LAN-IP>:8080`
- Icecast: `http://<LAN-IP>:8000`

## Install OP25 supervisor service

```bash
cd /opt/stacks/rf-console
sudo cp op25/host/op25-supervisor.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now op25-supervisor.service
sudo systemctl status op25-supervisor.service
```

Logs:

```bash
sudo journalctl -u op25-supervisor.service -f
```

## Profile Builder (UI)

Use the **Profile Builder** tab to import AZDPS/MCSO data.

### Supported import methods

1. Paste CSV into the textarea
2. Upload `.csv` file
3. Upload `.json` file (converted to preview)
4. Drop JSON file into `/opt/stacks/rf-console/data/profiles/<PROFILE>.import.json` then click `Import from /data/profiles JSON`

### CSV template (talkgroups)

```csv
tgid,label,mode,encrypted,category,favorite,enabled
1201,Dispatch A,D,false,dispatch,true,true
1202,TAC 2,T,false,tac,false,true
1299,Encrypted Ops,DE,true,ops,false,true
```

`mode` values:
- `D` clear digital
- `T` clear trunked
- `DE` digital encrypted
- `TE` trunked encrypted

### JSON template (profile + talkgroups)

```json
{
  "label": "AZDPS",
  "description": "User supplied import",
  "system": {
    "name": "Arizona DPS",
    "sysid": "123",
    "wacn": "BEE00",
    "nac": "293",
    "bandplan": "P25 Auto",
    "sites": [
      {
        "name": "Phoenix Simulcast",
        "controlChannels": ["771.10625", "771.35625"],
        "alternateChannels": ["770.85625"],
        "nac": "293"
      }
    ]
  },
  "talkgroups": {
    "entries": [
      {
        "tgid": 1201,
        "label": "Dispatch A",
        "mode": "D",
        "encrypted": false,
        "category": "dispatch",
        "favorite": true,
        "enabled": true
      }
    ]
  }
}
```

## Talkgroup UX

- Search by TGID or label
- Category filter
- Favorites-only toggle
- Show encrypted toggle (default off)
- Pagination (40 rows/page)
- Bulk enable/disable by category

## Filtering behavior

On save/import, backend computes filter policy:
- If enabled `allow` entries exist => `whitelist` mode (only those TGs pass)
- If no enabled allow entries => `blacklist` mode (enabled deny list blocked)

Filter state is written to:
- `/opt/stacks/rf-console/data/profiles/<PROFILE>.talkgroups.json`
- `/opt/stacks/rf-console/data/runtime/<PROFILE>.filter.json`

Any talkgroup/profile import/save triggers safe OP25 reload via runtime reload request.

## REST API

Base URL: `http://<LAN-IP>:8080`

- `GET /api/status`
- `GET /api/health`
- `GET /api/profiles`
- `POST /api/profiles/switch`
- `GET /api/talkgroups/:profile`
- `PUT /api/talkgroups/:profile`
- `POST /api/talkgroups/import/:profile/preview`
- `POST /api/talkgroups/import/:profile/save`
- `POST /api/import/profile/:profile/preview`
- `POST /api/import/profile/:profile/save`
- `POST /api/import/profile/:profile/from-json-file`
- `GET /api/import/templates`

## System health indicators

UI polls `/api/health` every ~4s for:
- backend API
- Icecast reachability + mount status
- streamer source connected
- OP25 supervisor (`systemctl` best-effort)
- OP25 process + lock + decode recency
- ALSA loopback detection
- SDR utility presence (`rtl_sdr` warning if missing)

## Encrypted traffic

- No decryption is attempted.
- Metadata can still appear for encrypted talkgroups while audio remains unavailable.

## Troubleshooting

- No audio:
  - Verify `snd-aloop` loaded
  - Verify OP25 command uses `-O plughw:Loopback,0,0`
  - Check streamer logs: `docker compose logs -f streamer`
- No status updates:
  - Check `journalctl -u op25-supervisor.service -f`
  - Check `/opt/stacks/rf-console/data/runtime/op25-status.json`
- Profile switch does not take effect:
  - Verify `op25-supervisor.service` is active
  - Verify runtime files are writable
