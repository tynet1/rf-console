#!/usr/bin/env python3
import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path

ACTIVE_PROFILE_FILES = [
    Path("/runtime/active-profile.json"),
    Path("/runtime/active_profile.json"),
]
PROFILES_DIR = Path(os.environ.get("OP25_PROFILES_DIR", "/config"))
RUNTIME_DIR = Path(os.environ.get("OP25_RUNTIME_DIR", "/runtime"))
ICECAST_URL = os.environ.get("OP25_ICECAST_URL", "http://icecast:8000/stream").strip()

APPS_DIR_CANDIDATES = [
    Path("/op25/op25/gr-op25_repeater/apps"),
    Path("/opt/op25/op25/gr-op25_repeater/apps"),
    Path("/opt/src/op25/op25/gr-op25_repeater/apps"),
]


class RunnerError(Exception):
    pass


def read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise RunnerError(f"failed to parse JSON {path}: {exc}")


def find_active_profile_file() -> Path:
    custom = os.environ.get("OP25_ACTIVE_PROFILE_FILE", "").strip()
    if custom:
        p = Path(custom)
        if p.exists():
            return p

    for path in ACTIVE_PROFILE_FILES:
        if path.exists():
            return path

    raise RunnerError("active profile file not found (checked /runtime/active-profile.json and /runtime/active_profile.json)")


def active_profile_name() -> str:
    payload = read_json(find_active_profile_file())
    profile = payload.get("profile") or payload.get("activeProfile")
    if not isinstance(profile, str) or not re.match(r"^[A-Za-z0-9_-]{1,64}$", profile):
        raise RunnerError("active profile JSON must contain profile/activeProfile with safe name")
    return profile


def profile_doc(profile: str):
    path = PROFILES_DIR / f"{profile}.profile.json"
    if not path.exists():
        raise RunnerError(f"profile JSON missing: {path}")
    return read_json(path)


def discover_apps_dir() -> tuple[Path, Path]:
    checked = []
    for apps_dir in APPS_DIR_CANDIDATES:
        rx = apps_dir / "rx.py"
        checked.append(str(rx))
        if apps_dir.exists() and rx.exists():
            return apps_dir, rx
    raise RunnerError(f"rx.py not found. checked: {', '.join(checked)}")


def profile_command(profile: str, doc) -> list[str]:
    command = doc.get("command")
    if isinstance(command, str):
        return shlex.split(command)
    if isinstance(command, list) and command and all(isinstance(x, str) for x in command):
        return list(command)

    # fallback minimal command (rx.py resolved later)
    return [
        "python3",
        "rx.py",
        "--args",
        "rtl",
        "-S",
        "2400000",
        "-T",
        f"/config/{profile}.trunk.tsv",
        "-2",
        "-V",
        "-U",
    ]


def replace_host_paths(token: str) -> str:
    token = token.replace("{PROFILES_DIR}", "/config")
    token = token.replace("{RUNTIME_DIR}", "/runtime")
    token = token.replace("/opt/stacks/rf-console/data/profiles", "/config")
    token = token.replace("/opt/stacks/rf-console/data/runtime", "/runtime")
    token = token.replace("/data/profiles", "/config")
    token = token.replace("/data/runtime", "/runtime")
    return token


def normalize_command(profile: str, command: list[str], rx_py: Path) -> list[str]:
    normalized = [replace_host_paths(t) for t in command]

    # normalize legacy profile tsv references
    normalized = [t.replace(f"{profile}.tsv", f"{profile}.trunk.tsv") for t in normalized]

    # force discovered rx.py path for any rx.py token
    rewritten = []
    for token in normalized:
        if token.endswith("rx.py"):
            rewritten.append(str(rx_py))
        else:
            rewritten.append(token)
    normalized = rewritten

    if not any(t.endswith("rx.py") for t in normalized):
        if normalized and normalized[0].startswith("python"):
            normalized.insert(1, str(rx_py))
        else:
            normalized.insert(0, str(rx_py))

    trunk_path = str(PROFILES_DIR / f"{profile}.trunk.tsv")
    if not Path(trunk_path).exists():
        raise RunnerError(f"required trunk file not found: {trunk_path}")

    tags_path = str(PROFILES_DIR / f"{profile}.tags.tsv")
    if not Path(tags_path).exists():
        raise RunnerError(f"required tags file not found: {tags_path}")

    # enforce -T trunk config
    if "-T" in normalized:
        i = normalized.index("-T")
        if i + 1 < len(normalized):
            normalized[i + 1] = trunk_path
        else:
            normalized.append(trunk_path)
    else:
        normalized.extend(["-T", trunk_path])

    # strip ALSA output flags for direct Icecast mode
    out = []
    skip_next = False
    for token in normalized:
        if skip_next:
            skip_next = False
            continue
        if token == "-O":
            skip_next = True
            continue
        low = token.lower()
        if "plughw:" in low or low.startswith("hw:"):
            continue
        out.append(token)
    normalized = out

    # enforce direct Icecast output
    if "-w" in normalized:
        i = normalized.index("-w")
        if i + 1 < len(normalized):
            normalized[i + 1] = ICECAST_URL
        else:
            normalized.append(ICECAST_URL)
    else:
        normalized.extend(["-w", ICECAST_URL])

    return normalized


def runtime_summary():
    config_exists = PROFILES_DIR.exists()
    runtime_exists = RUNTIME_DIR.exists()
    profile_files = sorted(p.name for p in PROFILES_DIR.glob("*.profile.json"))[:8] if config_exists else []
    return {
        "config_exists": config_exists,
        "runtime_exists": runtime_exists,
        "sample_profiles": profile_files,
    }


def write_tail(text: str):
    try:
        tail = RUNTIME_DIR / "op25-docker-tail.txt"
        tail.write_text(text[-16000:], encoding="utf-8")
    except Exception:
        pass


def main():
    try:
        profile = active_profile_name()
        doc = profile_doc(profile)
        apps_dir, rx_py = discover_apps_dir()
        cmd = normalize_command(profile, profile_command(profile, doc), rx_py)

        launch = " ".join(shlex.quote(x) for x in cmd)
        rs = runtime_summary()

        print(f"[op25-runner] profile={profile}", flush=True)
        print(f"[op25-runner] config_dir={PROFILES_DIR} exists={rs['config_exists']}", flush=True)
        print(f"[op25-runner] runtime_dir={RUNTIME_DIR} exists={rs['runtime_exists']}", flush=True)
        print(f"[op25-runner] profile_files_sample={','.join(rs['sample_profiles']) if rs['sample_profiles'] else '(none)'}", flush=True)
        print(f"[op25-runner] apps_dir={apps_dir}", flush=True)
        print(f"[op25-runner] rx_py={rx_py}", flush=True)
        print(f"[op25-runner] command={launch}", flush=True)

        write_tail(
            f"profile={profile}\n"
            f"config_dir={PROFILES_DIR}\n"
            f"runtime_dir={RUNTIME_DIR}\n"
            f"apps_dir={apps_dir}\n"
            f"rx_py={rx_py}\n"
            f"cmd={launch}\n"
        )

        child = subprocess.Popen(
            cmd,
            cwd=str(apps_dir),
            stdout=sys.stdout,
            stderr=sys.stderr,
            text=True,
        )
        child.wait()
        raise SystemExit(child.returncode)
    except RunnerError as exc:
        msg = f"[op25-runner] ERROR: {exc}"
        print(msg, file=sys.stderr, flush=True)
        write_tail(msg + "\n")
        raise SystemExit(2)


if __name__ == "__main__":
    main()
