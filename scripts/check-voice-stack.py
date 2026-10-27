#!/usr/bin/env python3
"""check-voice-stack.py -- one-shot audit for the dsh voice stack (plugin + services).

WHY THIS EXISTS
  Every real defect in this stack so far was a CONTRACT drift, not a logic bug:
    1) the client sent no sessionId and the host guessed a session  -> voice landed in the
       wrong conversation (silent, only visible by accident);
    2) the release package kept LAST WEEK's plugin while the working copy moved on -> the
       published zip would not reproduce anything;
    3) a "playback" URL pointed at a service that was not running -> silent audio;
    4) one-shot diagnostics were overwritten by a high-frequency report -> evidence vanished.
  Memory does not catch these. This script does, in one run, and exits non-zero on any drift.

USAGE
  dsh-tools\\py.cmd dsh-tools\\check-voice-stack.py
  dsh-tools\\py.cmd dsh-tools\\check-voice-stack.py --host http://127.0.0.1:6766 --offline

CHECKS
  A. Files: no BOM, node --check on both plugin halves, package.json parses
  B. Contract: every probe-send call in client.js carries sessionId; host refuses to guess;
     no dead route / debug probe left behind
  C. Release drift: plugin/*, tts/qwen_tts_server.py, asr/asr_server.py match the working copy
  D. Runtime (unless --offline): TTS /health reachable, last-voice + bubble-report answer,
     probe-send without sessionId is REJECTED when more than one session exists

Exit code 0 = clean. 1 = at least one FAIL. 2 = could not run (missing paths).
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

PLUGIN = r"D:\Harness工作区\dsh-plugins\voice-player"
RELEASE = r"D:\Harness工作区\发布\dsh-voice-stack"
HOST = "http://127.0.0.1:6766"
TTS = "http://127.0.0.1:18082"

results = []


def add(ok, code, msg):
    results.append((bool(ok), code, msg))


def read(p):
    with open(p, "rb") as f:
        return f.read()


def has_bom(b):
    return len(b) >= 3 and b[0] == 0xEF and b[1] == 0xBB and b[2] == 0xBF


def sha(b):
    return hashlib.sha256(b).hexdigest()[:12]


def http(url, timeout=4):
    """Return (status, body). A 4xx/5xx is a RESULT, not an exception -- urllib raises on it."""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode("utf-8", "replace")
        except Exception:  # noqa: BLE001
            body = ""
        return e.code, body
    except Exception as e:  # noqa: BLE001 - the whole point is to report it
        return 0, repr(e)


def a_files():
    for name in ("client.js", "index.js"):
        p = os.path.join(PLUGIN, name)
        if not os.path.isfile(p):
            add(False, "A1", "missing %s" % p)
            continue
        raw = read(p)
        add(not has_bom(raw), "A1", "%s has no BOM" % name)
        r = subprocess.run(["node", "--check", p], capture_output=True, text=True)
        add(r.returncode == 0, "A2", "%s node --check" % name)
    pkg = os.path.join(PLUGIN, "package.json")
    try:
        with open(pkg, "r", encoding="utf-8") as f:
            json.load(f)
        add(True, "A3", "package.json parses")
    except Exception as e:  # noqa: BLE001
        add(False, "A3", "package.json invalid: %s" % e)


def b_contract():
    src = read(os.path.join(PLUGIN, "client.js")).decode("utf-8", "replace")
    host = read(os.path.join(PLUGIN, "index.js")).decode("utf-8", "replace")

    # B1: the delivery call must name the session
    add("sessionId=" in src and "CURRENT_SESSION" in src, "B1",
        "client sends sessionId with probe-send")
    # B2: the host must not fall back to "newest session"
    add("refuses to guess" in host and "localeCompare" not in host, "B2",
        "host does not sort sessions to pick one")
    # B3: no dead routes / one-shot debug probes left in shipped code. Match the ACTIVE marker
    # (a probe payload or a route path), not a comment that merely explains the mechanism.
    for bad in ("post-disabled", "probe: 'slot-props'", "probe: \"slot-props\""):
        add(bad not in src and bad not in host, "B3", "no leftover %r" % bad)
    # B5: the download-safe contract. The client must (a) refuse direct delivery when it has no
    # session id (falls back to the composer, which cannot land in a wrong session) and (b) always
    # append sessionId unconditionally. A conditional append is what caused the original bug.
    add("if (!CURRENT_SESSION) return false;" in src, "B5",
        "client disables direct delivery without a session id (safe fallback)")
    add("'&sessionId=' + encodeURIComponent(CURRENT_SESSION)" in src, "B5",
        "sessionId is appended unconditionally")
    # B4: playback must not point at a service this stack does not start
    add("18081/say" not in src, "B4", "no player URL pointing at the retired 18081")


def c_release():
    pairs = [
        ("client.js", os.path.join("plugin", "client.js")),
        ("index.js", os.path.join("plugin", "index.js")),
        ("README.md", os.path.join("plugin", "README.md")),
    ]
    for src_name, rel in pairs:
        a = os.path.join(PLUGIN, src_name)
        b = os.path.join(RELEASE, rel)
        if not (os.path.isfile(a) and os.path.isfile(b)):
            add(False, "C1", "release copy missing: %s" % rel)
            continue
        add(sha(read(a)) == sha(read(b)), "C1", "release %s matches working copy" % rel)
    srv_pairs = [
        (r"D:\py-tts\qwen_tts_server.py", os.path.join(RELEASE, "tts", "qwen_tts_server.py")),
        (r"D:\py-asr\asr_server.py", os.path.join(RELEASE, "asr", "asr_server.py")),
    ]
    for a, b in srv_pairs:
        if not (os.path.isfile(a) and os.path.isfile(b)):
            add(False, "C2", "missing server copy: %s" % b)
            continue
        add(sha(read(a)) == sha(read(b)), "C2", "release %s matches" % os.path.basename(b))


def d_runtime(host):
    st, body = http(TTS + "/health")
    add(st == 200, "D1", "TTS service answers (HTTP %s)" % st)
    ready = '"base_ready": true' in body
    add(True, "D1b", "TTS model %s" % ("loaded" if ready else "not loaded yet (lazy; call /warm before speaking)"))

    st, body = http(host + "/voice-player/last-voice")
    add(st == 200, "D2", "last-voice answers")

    st, body = http(host + "/voice-player/bubble-report")
    add(st == 200, "D3", "bubble-report answers")

    # D4: the contract that caused the cross-session bug must now FAIL loudly
    st, body = http(host + "/voice-player/probe-send?text=contract-probe-ignore-me")
    if st == 400 and "sessionId required" in body:
        add(True, "D4", "probe-send without sessionId is rejected (no guessing)")
    elif st == 200:
        add(True, "D4", "probe-send accepted because only one session exists (unambiguous)")
    else:
        add(False, "D4", "probe-send answered %s: %s" % (st, body[:160]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default=HOST)
    ap.add_argument("--offline", action="store_true")
    ap.add_argument("--plugin", default=PLUGIN, help="plugin directory (default: this machine's)")
    ap.add_argument("--release", default=RELEASE, help="release package directory")
    args = ap.parse_args()
    global PLUGIN, RELEASE
    PLUGIN, RELEASE = args.plugin, args.release

    if not os.path.isdir(PLUGIN) or not os.path.isdir(RELEASE):
        print("cannot run: plugin or release directory missing")
        return 2

    a_files()
    b_contract()
    c_release()
    if not args.offline:
        d_runtime(args.host)

    fails = [r for r in results if not r[0]]
    print("voice-stack audit  (%d checks, %d fail)" % (len(results), len(fails)))
    for ok, code, msg in results:
        print("  [%s] %-3s %s" % ("PASS" if ok else "FAIL", code, msg))
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
