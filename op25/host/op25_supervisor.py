#!/usr/bin/env python3
import argparse
import json
import os
import re
import signal
import subprocess
import threading
import time
from collections import deque
from pathlib import Path

FREQ_RE = re.compile(r"(?:freq|frequency)[^0-9]*([0-9]+(?:\.[0-9]+)?)", re.IGNORECASE)
RSSI_RE = re.compile(r"(?:rssi)[^\-0-9]*(-?[0-9]+(?:\.[0-9]+)?)", re.IGNORECASE)
SYSID_RE = re.compile(r"sysid[^0-9a-fA-F]*([0-9a-fA-F]+)", re.IGNORECASE)
WACN_RE = re.compile(r"wacn[^0-9a-fA-F]*([0-9a-fA-F]+)", re.IGNORECASE)
NAC_RE = re.compile(r"nac[^0-9a-fA-F]*([0-9a-fA-F]+)", re.IGNORECASE)
TG_RE = re.compile(r"(?:tg|talkgroup|tgid)[^0-9]*([0-9]+)", re.IGNORECASE)
LOCK_RE = re.compile(r"(?:locked|sync|tracking|lock)", re.IGNORECASE)
UNLOCK_RE = re.compile(r"(?:no\s+lock|unlock|searching|hunt)", re.IGNORECASE)


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


class Supervisor:
    def __init__(self, profiles_dir: Path, runtime_dir: Path, active_profile_file: Path, op25_cwd: Path, op25_pythonpath: str):
        self.profiles_dir = profiles_dir
        self.runtime_dir = runtime_dir
        self.active_profile_file = active_profile_file
        self.legacy_active_profile_file = runtime_dir / "active_profile.json"
        self.op25_cwd = op25_cwd
        self.op25_pythonpath = op25_pythonpath

        self.status_file = runtime_dir / "op25-status.json"
        self.reload_file = runtime_dir / "reload-request.json"
        self.child_log_file = runtime_dir / "op25-child.log"

        self.proc = None
        self.proc_lock = threading.Lock()
        self.active_profile = None
        self.last_reload_mtime = 0.0
        self.stop_requested = False

        self.error_tail = deque(maxlen=100)
        self.child_log_handle = None

        self.status = {
            "running": False,
            "locked": False,
            "lastDecodeTime": None,
            "lastExitCode": None,
            "lastStartCommand": None,
            "lastErrorTail": "",
            "timestamp": None,
            "startedAt": None,
            "lastUpdated": None,
            "currentControlFrequency": None,
            "rssi": None,
            "system": {"sysid": None, "wacn": None, "nac": None},
            "talkgroup": {"current": None, "last": None},
            "note": "waiting for profile"
        }

    def write_status(self):
        self.status["lastUpdated"] = now_iso()
        self.status["timestamp"] = self.status["lastUpdated"]
        self.status["lastErrorTail"] = "\n".join(self.error_tail)
        payload = json.dumps(self.status, indent=2) + "\n"
        self.status_file.write_text(payload)

    def migrate_active_profile_legacy(self):
        if self.active_profile_file.exists():
            return
        if not self.legacy_active_profile_file.exists():
            return
        try:
            data = json.loads(self.legacy_active_profile_file.read_text())
            self.active_profile_file.write_text(json.dumps(data, indent=2) + "\n")
            self.legacy_active_profile_file.unlink(missing_ok=True)
            self.status["note"] = "migrated legacy active_profile.json -> active-profile.json"
            self.write_status()
        except Exception as exc:
            self.status["note"] = f"legacy active profile migration failed: {exc}"
            self.write_status()

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

    def write_child_line(self, text):
        if not text:
            return
        self.error_tail.append(text)
        if self.child_log_handle:
            self.child_log_handle.write(text + "\n")
            self.child_log_handle.flush()

    def parse_line(self, line):
        text = line.rstrip("\n")
        if text == "":
            return

        self.write_child_line(text)
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
            self.status["lastDecodeTime"] = now_iso()

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
        self.status["lastExitCode"] = proc.returncode
        self.status["note"] = f"stopped process exit={proc.returncode}"
        self.write_status()

    def start_process(self, profile):
        cmd = self.build_command(profile)
        self.error_tail.clear()
        if self.child_log_handle is None:
            self.child_log_handle = self.child_log_file.open("a", encoding="utf-8")

        env = None
        if self.op25_pythonpath:
            env = dict(os.environ)
            existing = env.get("PYTHONPATH", "")
            env["PYTHONPATH"] = self.op25_pythonpath if not existing else f"{self.op25_pythonpath}:{existing}"

        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            cwd=str(self.op25_cwd),
            env=env,
        )

        with self.proc_lock:
            self.proc = proc

        self.status["running"] = True
        self.status["locked"] = False
        self.status["startedAt"] = now_iso()
        self.status["lastExitCode"] = None
        self.status["lastStartCommand"] = " ".join(cmd)
        self.status["note"] = f"running profile {profile}"
        self.write_status()

        t = threading.Thread(target=self.read_output, args=(proc.stdout,), daemon=True)
        t.start()

    def run(self):
        self.runtime_dir.mkdir(parents=True, exist_ok=True)
        self.profiles_dir.mkdir(parents=True, exist_ok=True)
        self.migrate_active_profile_legacy()

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
                        self.status["lastExitCode"] = 127
                        self.status["note"] = f"start failed for {desired}: {exc}"
                        self.write_child_line(self.status["note"])
                        self.write_status()

            with self.proc_lock:
                proc = self.proc

            if proc and proc.poll() is not None:
                code = proc.returncode
                with self.proc_lock:
                    self.proc = None
                self.status["running"] = False
                self.status["locked"] = False
                self.status["startedAt"] = None
                self.status["lastExitCode"] = code
                self.status["note"] = f"process exited with code {code}; retrying"
                self.write_child_line(self.status["note"])
                self.write_status()
                time.sleep(2)
                continue

            time.sleep(1)

        self.stop_process()
        if self.child_log_handle is not None:
            self.child_log_handle.close()
            self.child_log_handle = None

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
    parser.add_argument(
        "--op25-cwd",
        default="/opt/src/op25/op25/gr-op25_repeater/apps",
        help="working directory for launching OP25 rx.py",
    )
    parser.add_argument(
        "--op25-pythonpath",
        default="",
        help="optional PYTHONPATH prefix for OP25 child process",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    profiles_dir = Path(args.profiles_dir)
    runtime_dir = Path(args.runtime_dir)
    active_file = Path(args.active_profile_file) if args.active_profile_file else runtime_dir / "active-profile.json"

    sup = Supervisor(
        profiles_dir=profiles_dir,
        runtime_dir=runtime_dir,
        active_profile_file=active_file,
        op25_cwd=Path(args.op25_cwd),
        op25_pythonpath=args.op25_pythonpath,
    )
    signal.signal(signal.SIGTERM, sup.request_stop)
    signal.signal(signal.SIGINT, sup.request_stop)
    sup.run()


if __name__ == "__main__":
    main()
