#!/usr/bin/env python3
import argparse
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

FREQ_RE = re.compile(r"(?:freq|frequency)[^0-9]*([0-9]+(?:\.[0-9]+)?)", re.IGNORECASE)
RSSI_RE = re.compile(r"(?:rssi)[^\-0-9]*(-?[0-9]+(?:\.[0-9]+)?)", re.IGNORECASE)
SYSID_RE = re.compile(r"sysid[^0-9a-fA-F]*([0-9a-fA-F]+)", re.IGNORECASE)
WACN_RE = re.compile(r"wacn[^0-9a-fA-F]*([0-9a-fA-F]+)", re.IGNORECASE)
NAC_RE = re.compile(r"nac[^0-9a-fA-F]*([0-9a-fA-F]+)", re.IGNORECASE)
TG_RE = re.compile(r"(?:tg|talkgroup|tgid)[^0-9]*([0-9]+)", re.IGNORECASE)
LOCK_RE = re.compile(r"(?:locked|sync|tracking|lock)", re.IGNORECASE)
UNLOCK_RE = re.compile(r"(?:no\\s+lock|unlock|searching|hunt)", re.IGNORECASE)


class Supervisor:
    def __init__(self, profiles_dir: Path, runtime_dir: Path, active_profile_file: Path):
        self.profiles_dir = profiles_dir
        self.runtime_dir = runtime_dir
        self.active_profile_file = active_profile_file
        self.status_file = runtime_dir / "op25-status.json"
        self.reload_file = runtime_dir / "reload-request.json"
        self.proc = None
        self.proc_lock = threading.Lock()
        self.active_profile = None
        self.last_reload_mtime = 0.0
        self.stop_requested = False
        self.status = {
            "running": False,
            "locked": False,
            "lastDecodeTime": None,
            "startedAt": None,
            "lastUpdated": None,
            "currentControlFrequency": None,
            "rssi": None,
            "system": {"sysid": None, "wacn": None, "nac": None},
            "talkgroup": {"current": None, "last": None},
            "note": "waiting for profile"
        }

    def write_status(self):
        self.status["lastUpdated"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        payload = json.dumps(self.status, indent=2) + "\n"
        self.status_file.write_text(payload)

    def read_active_profile(self):
        if not self.active_profile_file.exists():
            return None
        try:
            data = json.loads(self.active_profile_file.read_text())
            profile = data.get("profile")
            if isinstance(profile, str) and re.match(r"^[A-Za-z0-9_-]{1,64}$", profile):
                return profile
        except Exception:
            return None
        return None

    def profile_path(self, profile):
        return self.profiles_dir / f"{profile}.profile.json"

    def build_command(self, profile):
        file_path = self.profile_path(profile)
        if not file_path.exists():
            raise RuntimeError(f"profile file not found: {file_path}")

        raw = json.loads(file_path.read_text())
        command = raw.get("command")
        if not isinstance(command, list) or not command:
            raise RuntimeError(f"profile {profile} has no command array")

        tg_file = self.profiles_dir / f"{profile}.talkgroups.json"
        rendered = []
        for token in command:
            if not isinstance(token, str):
                raise RuntimeError("profile command entries must be strings")
            token = token.replace("{PROFILE}", profile)
            token = token.replace("{PROFILES_DIR}", str(self.profiles_dir))
            token = token.replace("{RUNTIME_DIR}", str(self.runtime_dir))
            token = token.replace("{TG_FILTER_FILE}", str(tg_file))
            rendered.append(token)
        return rendered

    def parse_line(self, line):
        text = line.strip()
        if not text:
            return

        self.status["note"] = text[-220:]

        m = FREQ_RE.search(text)
        if m:
            self.status["currentControlFrequency"] = m.group(1)

        m = RSSI_RE.search(text)
        if m:
            try:
                self.status["rssi"] = float(m.group(1))
            except ValueError:
                pass

        m = SYSID_RE.search(text)
        if m:
            self.status["system"]["sysid"] = m.group(1)

        m = WACN_RE.search(text)
        if m:
            self.status["system"]["wacn"] = m.group(1)

        m = NAC_RE.search(text)
        if m:
            self.status["system"]["nac"] = m.group(1)

        m = TG_RE.search(text)
        if m:
            tg = m.group(1)
            prev = self.status["talkgroup"]["current"]
            self.status["talkgroup"]["current"] = tg
            if prev and prev != tg:
                self.status["talkgroup"]["last"] = prev
            self.status["lastDecodeTime"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

        if LOCK_RE.search(text):
            self.status["locked"] = True
        if UNLOCK_RE.search(text):
            self.status["locked"] = False

        self.write_status()

    def read_output(self, pipe):
        for line in iter(pipe.readline, ""):
            self.parse_line(line)
        pipe.close()

    def stop_process(self):
        with self.proc_lock:
            if not self.proc:
                return
            proc = self.proc
            self.proc = None

        try:
            proc.terminate()
            proc.wait(timeout=8)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass

        self.status["running"] = False
        self.status["locked"] = False
        self.status["startedAt"] = None
        self.write_status()

    def start_process(self, profile):
        cmd = self.build_command(profile)
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )

        with self.proc_lock:
            self.proc = proc

        self.status["running"] = True
        self.status["locked"] = False
        self.status["startedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self.status["note"] = f"running profile {profile}"
        self.write_status()

        t = threading.Thread(target=self.read_output, args=(proc.stdout,), daemon=True)
        t.start()

    def run(self):
        self.runtime_dir.mkdir(parents=True, exist_ok=True)
        self.profiles_dir.mkdir(parents=True, exist_ok=True)
        if self.reload_file.exists():
            self.last_reload_mtime = self.reload_file.stat().st_mtime
        self.write_status()

        while not self.stop_requested:
            desired = self.read_active_profile()
            should_reload = False

            if self.reload_file.exists():
                mtime = self.reload_file.stat().st_mtime
                if mtime > self.last_reload_mtime:
                    self.last_reload_mtime = mtime
                    should_reload = True

            if desired != self.active_profile or should_reload:
                self.stop_process()
                self.active_profile = desired
                if desired:
                    try:
                        self.start_process(desired)
                    except Exception as exc:
                        self.status["running"] = False
                        self.status["note"] = f"start failed for {desired}: {exc}"
                        self.write_status()

            with self.proc_lock:
                proc = self.proc

            if proc and proc.poll() is not None:
                code = proc.returncode
                with self.proc_lock:
                    self.proc = None
                self.status["running"] = False
                self.status["note"] = f"process exited with code {code}; retrying"
                self.write_status()
                time.sleep(2)
                continue

            time.sleep(1)

        self.stop_process()

    def request_stop(self, *_args):
        self.stop_requested = True


def parse_args():
    parser = argparse.ArgumentParser(description="OP25 profile supervisor")
    parser.add_argument(
        "--profiles-dir",
        default="/opt/stacks/rf-console/data/profiles",
        help="directory containing <profile>.profile.json files",
    )
    parser.add_argument(
        "--runtime-dir",
        default="/opt/stacks/rf-console/data/runtime",
        help="directory for status and active profile files",
    )
    parser.add_argument(
        "--active-profile-file",
        default="",
        help="optional explicit active profile file path",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    profiles_dir = Path(args.profiles_dir)
    runtime_dir = Path(args.runtime_dir)
    active_file = Path(args.active_profile_file) if args.active_profile_file else runtime_dir / "active-profile.json"

    sup = Supervisor(profiles_dir, runtime_dir, active_file)
    signal.signal(signal.SIGTERM, sup.request_stop)
    signal.signal(signal.SIGINT, sup.request_stop)
    sup.run()


if __name__ == "__main__":
    main()
