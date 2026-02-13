#!/usr/bin/env python3
import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path

ACTIVE_PROFILE_FILES = [
    Path(os.environ.get("OP25_ACTIVE_PROFILE_FILE", "/runtime/active-profile.json")),
    Path("/runtime/active_profile.json"),
]
PROFILES_DIR = Path(os.environ.get("OP25_PROFILES_DIR", "/config"))
ICECAST_URL = os.environ.get("OP25_ICECAST_URL", "http://icecast:8000/stream").strip()

CWD_CANDIDATES = [
    Path(os.environ.get("OP25_CWD", "")),
    Path("/opt/src/op25/op25/gr-op25_repeater/apps"),
    Path("/opt/op25/op25/gr-op25_repeater/apps"),
]


class RunnerError(Exception):
    pass


def read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise RunnerError(f"failed to parse JSON {path}: {exc}")


def find_active_profile_file() -> Path:
    for path in ACTIVE_PROFILE_FILES:
        if path and path.exists():
            return path
    raise RunnerError("active profile file not found at /runtime/active-profile.json or /runtime/active_profile.json")


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


def profile_command(profile: str, doc) -> list[str]:
    command = doc.get("command")
    if isinstance(command, str):
        return shlex.split(command)
    if isinstance(command, list) and command and all(isinstance(x, str) for x in command):
        return list(command)

    # fallback minimal command
    return [
        "python3",
        "/opt/src/op25/op25/gr-op25_repeater/apps/rx.py",
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


def replace_host_profiles_path(token: str) -> str:
    token = token.replace("{PROFILES_DIR}", "/config")
    token = token.replace("{RUNTIME_DIR}", "/runtime")
    token = token.replace("/opt/stacks/rf-console/data/profiles", "/config")
    token = token.replace("/opt/stacks/rf-console/data/runtime", "/runtime")
    token = token.replace("/data/profiles", "/config")
    token = token.replace("/data/runtime", "/runtime")
    return token


def resolve_rx_path(token: str) -> str:
    if token.endswith("rx.py") and not token.startswith("/"):
        for cwd in CWD_CANDIDATES:
            if cwd and (cwd / token).exists():
                return str((cwd / token).resolve())
    return token


def normalize_command(profile: str, command: list[str]) -> list[str]:
    normalized = [resolve_rx_path(replace_host_profiles_path(t)) for t in command]

    # normalize profile tsv names
    normalized = [t.replace(f"{profile}.tsv", f"{profile}.trunk.tsv") for t in normalized]

    trunk_path = str(PROFILES_DIR / f"{profile}.trunk.tsv")
    if not Path(trunk_path).exists():
        raise RunnerError(f"required trunk file not found: {trunk_path}")

    # normalize -T trunk file
    if "-T" in normalized:
        i = normalized.index("-T")
        if i + 1 < len(normalized):
            normalized[i + 1] = trunk_path
        else:
            normalized.append(trunk_path)
    else:
        normalized.extend(["-T", trunk_path])

    # remove ALSA output flags
    out = []
    skip = 0
    for i, token in enumerate(normalized):
        if skip:
            skip -= 1
            continue
        if token == "-O":
            skip = 1
            continue
        if "plughw:" in token.lower() or token.lower().startswith("hw:"):
            continue
        out.append(token)
    normalized = out

    # enforce icecast output -w
    if "-w" in normalized:
        i = normalized.index("-w")
        if i + 1 < len(normalized):
            normalized[i + 1] = ICECAST_URL
        else:
            normalized.append(ICECAST_URL)
    else:
        normalized.extend(["-w", ICECAST_URL])

    return normalized


def find_cwd(command: list[str]) -> Path:
    # If command contains absolute rx.py, use its parent.
    for i, token in enumerate(command):
        if token.endswith("rx.py") and token.startswith("/"):
            p = Path(token)
            if p.exists():
                return p.parent
            raise RunnerError(f"rx.py path does not exist: {token}")

    for cwd in CWD_CANDIDATES:
        if cwd and cwd.exists() and (cwd / "rx.py").exists():
            return cwd

    raise RunnerError("rx.py not found in known OP25 paths inside container")


def validate_tags(profile: str):
    tags_path = PROFILES_DIR / f"{profile}.tags.tsv"
    if not tags_path.exists():
        raise RunnerError(f"required tags file not found: {tags_path}")


def write_tail(text: str):
    try:
        tail = Path("/runtime/op25-docker-tail.txt")
        tail.write_text(text[-16000:], encoding="utf-8")
    except Exception:
        pass


def main():
    try:
        profile = active_profile_name()
        doc = profile_doc(profile)
        validate_tags(profile)
        cmd = normalize_command(profile, profile_command(profile, doc))
        cwd = find_cwd(cmd)

        launch = " ".join(shlex.quote(x) for x in cmd)
        print(f"[op25-runner] active profile: {profile}", flush=True)
        print(f"[op25-runner] cwd: {cwd}", flush=True)
        print(f"[op25-runner] command: {launch}", flush=True)
        write_tail(f"profile={profile}\ncwd={cwd}\ncmd={launch}\n")

        child = subprocess.Popen(
            cmd,
            cwd=str(cwd),
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
