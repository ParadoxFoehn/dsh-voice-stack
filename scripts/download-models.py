# -*- coding: utf-8 -*-
"""Download the two required models from ModelScope into ./models.

Why a custom downloader instead of `modelscope download`: the repos list files we do
not need (TensorRT engines, batch tokenizers, cache tensors) - about 1.5 GB - and the
CosyVoice2 repo contains a sub-directory (CosyVoice-BlankEN) that the plain file API
returns as an empty entry, so it must be listed separately.

Usage:
    python scripts/download-models.py            # both models
    python scripts/download-models.py --only tts # or: asr | tts
"""
import argparse
import os
import sys
import urllib.parse
import urllib.request

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODELS_DIR = os.path.join(REPO_ROOT, "models")
API = "https://modelscope.cn/api/v1/models/{repo}/repo?Revision=master&FilePath={path}"
LIST = "https://modelscope.cn/api/v1/models/{repo}/repo/files?Revision=master{root}"

TTS_REPO = "iic/CosyVoice2-0.5B"
TTS_FILES = [
    "campplus.onnx",              # speaker embedding
    "configuration.json",
    "cosyvoice2.yaml",            # model config
    "flow.pt",                    # flow matching
    "hift.pt",                    # vocoder
    "llm.pt",                     # LLM backbone (largest file)
    "speech_tokenizer_v2.onnx",   # speech tokenizer
    "README.md",
]
TTS_SUBDIR = "CosyVoice-BlankEN"  # Qwen2.5-0.5B base used by the LLM; the API lists it as size 0
TTS_SUBDIR_FILES = ["config.json", "generation_config.json", "merges.txt", "model.safetensors",
                    "tokenizer_config.json", "vocab.json"]

ASR_REPO = "Qwen/Qwen3-ASR-1.7B"
ASR_FILES = [
    "config.json", "configuration.json", "generation_config.json", "preprocessor_config.json",
    "chat_template.json", "tokenizer_config.json", "merges.txt", "vocab.json", "README.md",
    "model.safetensors.index.json",
    "model-00001-of-00002.safetensors",
    "model-00002-of-00002.safetensors",
]


def remote_size(repo, path):
    url = LIST.format(repo=repo, root="&Root=" + urllib.parse.quote(path.rsplit("/", 1)[0])) if "/" in path else None
    if url is None:
        return None
    try:
        data = urllib.request.urlopen(url, timeout=20).read()
        import json
        for f in json.loads(data.decode("utf-8")).get("Data", {}).get("Files", []):
            if f.get("Path") == path:
                return int(f.get("Size") or 0)
    except Exception:
        return None
    return None


def fetch(repo, path, dest):
    url = API.format(repo=repo, path=urllib.parse.quote(path))
    tmp = dest + ".part"
    with urllib.request.urlopen(url, timeout=120) as r, open(tmp, "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    os.replace(tmp, dest)
    return os.path.getsize(dest)


def download(repo, files, target, subdir=None, subfiles=None):
    os.makedirs(target, exist_ok=True)
    plan = [(f, f) for f in files]
    if subdir and subfiles:
        plan += [("%s/%s" % (subdir, f), os.path.join(subdir, f)) for f in subfiles]
    total = 0
    for remote, rel in plan:
        dest = os.path.join(target, rel.replace("/", os.sep))
        os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
        if os.path.isfile(dest) and os.path.getsize(dest) > 0:
            total += os.path.getsize(dest)
            print("  have  %-46s %7.1f MB" % (rel, os.path.getsize(dest) / 1048576))
            continue
        print("  get   %-46s ..." % rel, flush=True)
        size = fetch(repo, remote, dest)
        total += size
        print("        done %7.1f MB" % (size / 1048576))
    print("  total %.1f MB -> %s" % (total / 1048576, target))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", choices=["asr", "tts"], help="download just one model")
    ap.add_argument("--models-dir", default=MODELS_DIR)
    a = ap.parse_args()

    if a.only in (None, "asr"):
        print("[1/2] Qwen3-ASR-1.7B (speech -> text, ~4.4 GB)")
        download(ASR_REPO, ASR_FILES, os.path.join(a.models_dir, "Qwen3-ASR-1.7B"))

    if a.only in (None, "tts"):
        print("[2/2] CosyVoice2-0.5B (text -> speech, ~4.4 GB; skips ~1.5 GB of TRT/batch files)")
        download(TTS_REPO, TTS_FILES, os.path.join(a.models_dir, "CosyVoice2-0.5B"),
                 TTS_SUBDIR, TTS_SUBDIR_FILES)

    print("\nAll model files are in place. Next: scripts\\verify.ps1")


if __name__ == "__main__":
    sys.exit(main())
