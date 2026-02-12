#!/usr/bin/env python3
import argparse
import base64
import json
import re
import shlex
import subprocess
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


def ts_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def run_command(command, timeout=20):
    try:
        proc = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout,
            executable="/bin/sh",
        )
        return {
            "ok": proc.returncode == 0,
            "stdout": proc.stdout[-12000:],
            "stderr": proc.stderr[-12000:],
            "exitCode": proc.returncode,
        }
    except subprocess.TimeoutExpired as exc:
        return {
            "ok": False,
            "stdout": (exc.stdout or "")[-12000:],
            "stderr": ((exc.stderr or "") + "\ncommand timed out")[-12000:],
            "exitCode": 124,
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "stdout": "",
            "stderr": str(exc),
            "exitCode": 127,
        }


def is_private_ip(ip):
    if not ip:
        return False
    if ip in ("127.0.0.1", "::1"):
        return True
    if ip.startswith("10.") or ip.startswith("192.168."):
        return True
    if re.match(r"^172\.(1[6-9]|2[0-9]|3[0-1])\.", ip):
        return True
    if ip.startswith("fc") or ip.startswith("fd"):
        return True
    return False


class Handler(BaseHTTPRequestHandler):
    token = ""
    private_only = True
    op25_service = "op25-supervisor.service"

    def _json(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _extract_ip(self):
        xff = self.headers.get("X-Forwarded-For", "").split(",")[0].strip()
        ip = xff or self.client_address[0]
        if ip.startswith("::ffff:"):
            ip = ip[7:]
        return ip

    def _extract_token(self):
        header = self.headers.get("X-Admin-Token", "").strip()
        if header:
            return header
        auth = self.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            return auth[7:].strip()
        if auth.startswith("Basic "):
            try:
                decoded = base64.b64decode(auth[6:]).decode("utf-8")
                if ":" in decoded:
                    return decoded.split(":", 1)[1]
                return decoded
            except Exception:  # noqa: BLE001
                return ""
        return ""

    def _auth(self):
        if not self.token:
            self._json(503, {"ok": False, "error": "ADMIN_TOKEN missing in helper"})
            return False
        supplied = self._extract_token()
        if supplied != self.token:
            self._json(401, {"ok": False, "error": "Unauthorized"})
            return False
        ip = self._extract_ip()
        if self.private_only and not is_private_ip(ip):
            self._json(403, {"ok": False, "error": f"Forbidden IP: {ip}"})
            return False
        return True

    def _action_command(self, action):
        service = shlex.quote(self.op25_service)
        commands = {
            "start-op25": f"systemctl start {service}",
            "restart-op25": f"systemctl restart {service}",
            "stop-op25": f"systemctl stop {service}",
            "load-alsa-loopback": "modprobe snd-aloop && grep -i Loopback /proc/asound/cards",
            "usb-sdr-check": "lsusb | grep -Ei 'rtl|realtek' || true; command -v rtl_sdr || true; id -nG",
            "restart-streamer": "docker restart rf-console-streamer",
            "restart-icecast": "docker restart rf-console-icecast",
            "restart-backend": "echo 'Backend should be restarted from shell: docker compose restart backend' >&2; exit 2",
        }
        return commands.get(action)

    def _log_command(self, target, lines):
        service = shlex.quote(self.op25_service)
        commands = {
            "op25": f"journalctl -u {service} -n {lines} --no-pager",
            "streamer": f"docker logs --tail={lines} rf-console-streamer",
            "icecast": f"docker logs --tail={lines} rf-console-icecast",
        }
        return commands.get(target)

    def _service_snapshot(self):
        op25_state = run_command(f"systemctl is-active {shlex.quote(self.op25_service)}", timeout=5)
        helper_state = run_command("systemctl is-active rf-control-helper.service", timeout=5)
        icecast_state = run_command("docker inspect -f '{{.State.Status}}' rf-console-icecast", timeout=5)
        streamer_state = run_command("docker inspect -f '{{.State.Status}}' rf-console-streamer", timeout=5)
        rx_state = run_command("pgrep -af 'rx.py' >/dev/null 2>&1", timeout=5)

        return {
            "op25-supervisor": {
                "state": (op25_state.get("stdout") or op25_state.get("stderr") or "unknown").strip() or "unknown",
                "message": (op25_state.get("stdout") or op25_state.get("stderr") or "unknown").strip(),
                "exitCode": op25_state.get("exitCode"),
            },
            "rf-control-helper": {
                "state": (helper_state.get("stdout") or helper_state.get("stderr") or "unknown").strip() or "unknown",
                "message": (helper_state.get("stdout") or helper_state.get("stderr") or "unknown").strip(),
                "exitCode": helper_state.get("exitCode"),
            },
            "icecast": {
                "state": (icecast_state.get("stdout") or "unknown").strip() or "unknown",
                "message": (icecast_state.get("stdout") or icecast_state.get("stderr") or "unknown").strip(),
                "exitCode": icecast_state.get("exitCode"),
            },
            "streamer": {
                "state": (streamer_state.get("stdout") or "unknown").strip() or "unknown",
                "message": (streamer_state.get("stdout") or streamer_state.get("stderr") or "unknown").strip(),
                "exitCode": streamer_state.get("exitCode"),
            },
            "rx.py": {
                "running": rx_state.get("ok", False),
                "message": "rx.py running" if rx_state.get("ok", False) else "rx.py not running",
                "exitCode": rx_state.get("exitCode"),
            },
        }

    def do_GET(self):  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            if not self._auth():
                return
            op25 = run_command(f"systemctl is-active {shlex.quote(self.op25_service)}", timeout=5)
            alsa = run_command("grep -qi loopback /proc/asound/cards", timeout=3)
            rtl_path = run_command("command -v rtl_sdr >/dev/null 2>&1", timeout=3)
            usb = run_command("lsusb | grep -Eiq 'rtl|realtek'", timeout=4)
            self._json(
                200,
                {
                    "ok": True,
                    "ts": ts_iso(),
                    "details": {
                        "op25SupervisorActive": op25.get("ok", False),
                        "op25Supervisor": op25.get("stdout") or op25.get("stderr") or "unknown",
                        "alsaLoopback": alsa.get("ok", False),
                        "rtlSdrInPath": rtl_path.get("ok", False),
                        "rtlUsbPresent": usb.get("ok", False),
                    },
                },
            )
            return

        if parsed.path == "/services":
            if not self._auth():
                return
            self._json(
                200,
                {
                    "ok": True,
                    "ts": ts_iso(),
                    "services": self._service_snapshot(),
                },
            )
            return

        if parsed.path.startswith("/logs/"):
            if not self._auth():
                return
            target = parsed.path.split("/")[-1]
            params = parse_qs(parsed.query)
            try:
                lines = int(params.get("lines", ["200"])[0])
            except ValueError:
                lines = 200
            lines = min(max(lines, 10), 1000)
            command = self._log_command(target, lines)
            if not command:
                self._json(400, {"ok": False, "error": f"Unknown log target: {target}"})
                return
            result = run_command(command, timeout=20)
            payload = {
                **result,
                "action": f"logs-{target}",
                "ts": ts_iso(),
            }
            self._json(200 if result["ok"] else 500, payload)
            return

        self._json(404, {"ok": False, "error": "Not found"})

    def do_POST(self):  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path.startswith("/action/"):
            if not self._auth():
                return
            action = parsed.path.split("/")[-1]
            command = self._action_command(action)
            if not command:
                self._json(400, {"ok": False, "error": f"Unknown action: {action}"})
                return
            result = run_command(command, timeout=30)
            payload = {
                **result,
                "action": action,
                "ts": ts_iso(),
            }
            self._json(200 if result["ok"] else 500, payload)
            return

        self._json(404, {"ok": False, "error": "Not found"})


def parse_args():
    p = argparse.ArgumentParser(description="RF console privileged control helper")
    p.add_argument("--bind", default="127.0.0.1")
    p.add_argument("--port", type=int, default=9911)
    p.add_argument("--token", default="")
    p.add_argument("--private-only", action="store_true", default=False)
    p.add_argument("--op25-service", default="op25-supervisor.service")
    return p.parse_args()


def main():
    args = parse_args()
    Handler.token = args.token
    Handler.private_only = args.private_only
    Handler.op25_service = args.op25_service

    server = ThreadingHTTPServer((args.bind, args.port), Handler)
    print(f"rf-control-helper listening on {args.bind}:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
