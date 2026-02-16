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
OP25_AUDIO_OUT = os.environ.get("OP25_AUDIO_OUT", "plughw:Loopback,0,0").strip()
OP25_IMAGE_REVISION = os.environ.get("OP25_IMAGE_REVISION", "unknown").strip() or "unknown"

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
        rx_py = apps_dir / "rx.py"
        checked.append(str(rx_py))
        if apps_dir.exists() and rx_py.exists():
            return apps_dir, rx_py
    raise RunnerError(f"rx.py not found. checked: {', '.join(checked)}")


def profile_command(profile: str, doc) -> list[str]:
    command = doc.get("command")
    if isinstance(command, str):
        return shlex.split(command)
    if isinstance(command, list) and command and all(isinstance(x, str) for x in command):
        return list(command)

    # Fallback command; rx.py path is injected after discovery.
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


def candidate_trunk(profile: str) -> str:
    trunk = PROFILES_DIR / f"{profile}.trunk.tsv"
    legacy = PROFILES_DIR / f"{profile}.tsv"
    if trunk.exists():
        return str(trunk)
    if legacy.exists():
        return str(legacy)
    return str(trunk)


def ensure_tags_file(profile: str) -> str:
    tags = PROFILES_DIR / f"{profile}.tags.tsv"
    if tags.exists():
        return str(tags)

    runtime_tags = RUNTIME_DIR / f"{profile}.tags.tsv"
    runtime_tags.parent.mkdir(parents=True, exist_ok=True)
    if not runtime_tags.exists():
        runtime_tags.write_text('"tgid"\t"tag"\t"mode"\n', encoding="utf-8")
    return str(runtime_tags)


def strip_alsa_device_tokens(tokens: list[str]) -> list[str]:
    cleaned = []
    for token in tokens:
        low = token.lower()
        if "plughw:" in low or low.startswith("hw:"):
            continue
        cleaned.append(token)
    return cleaned


def normalize_command(profile: str, command: list[str], rx_py: Path) -> list[str]:
    tokens = [replace_host_paths(t) for t in command]

    # normalize legacy profile tsv naming
    tokens = [t.replace(f"{profile}.tsv", f"{profile}.trunk.tsv") for t in tokens]

    # force discovered rx.py path for any rx.py token
    rewritten = []
    for token in tokens:
        if token.endswith("rx.py"):
            rewritten.append(str(rx_py))
        else:
            rewritten.append(token)
    tokens = rewritten

    # Ensure rx.py is present in argv.
    if not any(t.endswith("rx.py") for t in tokens):
        if tokens and tokens[0].startswith("python"):
            tokens.insert(1, str(rx_py))
        else:
            tokens.insert(0, str(rx_py))

    # Force selected trunk path for -T.
    trunk_path = candidate_trunk(profile)
    if "-T" in tokens:
        i = tokens.index("-T")
        if i + 1 < len(tokens):
            tokens[i + 1] = trunk_path
        else:
            tokens.append(trunk_path)
    else:
        tokens.extend(["-T", trunk_path])

    # Keep -w flag behavior for Wireshark, but remove legacy accidental URL argument.
    cleaned = []
    skip_next = False
    for i, token in enumerate(tokens):
        if skip_next:
            skip_next = False
            continue
        if token == "-w":
            cleaned.append(token)
            if i + 1 < len(tokens):
                nxt = tokens[i + 1]
                if nxt.startswith("http://") or nxt.startswith("https://"):
                    skip_next = True
            continue
        if token.startswith("http://") or token.startswith("https://"):
            if "icecast" in token or token.endswith("/stream"):
                continue
        cleaned.append(token)
    tokens = cleaned

    # Keep ALSA audio out; ensure -O exists.
    if "-O" in tokens:
        i = tokens.index("-O")
        if i + 1 < len(tokens):
            tokens[i + 1] = OP25_AUDIO_OUT
        else:
            tokens.append(OP25_AUDIO_OUT)
    else:
        tokens.extend(["-O", OP25_AUDIO_OUT])

    # If command had raw device tokens detached from -O, clear them to avoid confusion.
    tokens = strip_alsa_device_tokens(tokens)
    if "-O" in tokens:
        i = tokens.index("-O")
        if i + 1 >= len(tokens):
            tokens.append(OP25_AUDIO_OUT)

    # Touch/create tags file location so profile references are valid.
    tags_path = ensure_tags_file(profile)
    if "--tags-file" in tokens:
        i = tokens.index("--tags-file")
        if i + 1 < len(tokens):
            tokens[i + 1] = tags_path
        else:
            tokens.append(tags_path)

    return tokens


def runtime_summary():
    config_exists = PROFILES_DIR.exists()
    runtime_exists = RUNTIME_DIR.exists()
    profile_files = sorted(p.name for p in PROFILES_DIR.glob("*.profile.json"))[:10] if config_exists else []
    trunk_files = sorted(p.name for p in PROFILES_DIR.glob("*.trunk.tsv"))[:10] if config_exists else []
    return {
        "config_exists": config_exists,
        "runtime_exists": runtime_exists,
        "profile_files": profile_files,
        "trunk_files": trunk_files,
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

        rs = runtime_summary()
        launch = " ".join(shlex.quote(x) for x in cmd)

        print(f"[op25-runner] profile={profile}", flush=True)
        print(f"[op25-runner] revision={OP25_IMAGE_REVISION}", flush=True)
        print(f"[op25-runner] /config exists={rs['config_exists']} profiles={','.join(rs['profile_files']) if rs['profile_files'] else '(none)'}", flush=True)
        print(f"[op25-runner] /runtime exists={rs['runtime_exists']}", flush=True)
        print(f"[op25-runner] trunk sample={','.join(rs['trunk_files']) if rs['trunk_files'] else '(none)'}", flush=True)
        print(f"[op25-runner] apps_dir={apps_dir}", flush=True)
        print(f"[op25-runner] rx_py={rx_py}", flush=True)
        print(f"[op25-runner] command={launch}", flush=True)

        write_tail(
            f"profile={profile}\n"
            f"apps_dir={apps_dir}\n"
            f"rx_py={rx_py}\n"
            f"command={launch}\n"
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
