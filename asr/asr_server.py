r"""asr_server.py -- local OpenAI-compatible transcription endpoint backed by Qwen3-ASR.

Why: voice-input plugins (dsh-voice, dsh-ears, dsh-audio-copilot ...) can point at any
OpenAI-compatible /audio/transcriptions endpoint. This exposes the local model that way.

Run:  D:\py-asr\asr-server.cmd            (listens on 127.0.0.1:18080)
Test: curl.exe -s -F "file=@clip.wav" http://127.0.0.1:18080/v1/audio/transcriptions

Endpoints:
  GET  /health                     -> {"status":"ok","model":...,"device":...}
  GET  /v1/models                  -> OpenAI-style model list
  POST /v1/audio/transcriptions    -> {"text": "..."}   (multipart field `file`, like OpenAI)
"""
import argparse
import io
import json
import os
import subprocess
import sys
import threading
import time
import tempfile

# Helper processes must never flash a console window (user complaint 2026-10-24).
NO_WINDOW = 0x08000000 if os.name == "nt" else 0

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)


def _load_config():
    """config/config.json (written by scripts/install.ps1), else the shipped example."""
    path = os.environ.get("DSH_VOICE_CONFIG") or os.path.join(REPO, "config", "config.json")
    if not os.path.isfile(path):
        path = os.path.join(REPO, "config", "config.example.json")
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


CFG = _load_config()


def _p(value):
    if not value:
        return ""
    return value if os.path.isabs(value) else os.path.join(REPO, value)


DEF_MODEL = _p(CFG["paths"]["asr_model"])
DEF_PORT = int(CFG.get("ports", {}).get("asr", 18080))

# Voice plugins send ISO codes ("zh", "zh-CN", "yue"); the model accepts full names only,
# and rejects anything else with ValueError (a 500 for the caller).
LANG_MAP = {
    "zh": "Chinese", "zh-cn": "Chinese", "zh-hans": "Chinese", "cmn": "Chinese",
    "en": "English", "en-us": "English", "en-gb": "English",
    "yue": "Cantonese", "zh-hk": "Cantonese", "zh-yue": "Cantonese",
    "ja": "Japanese", "ko": "Korean", "de": "German", "fr": "French",
    "es": "Spanish", "pt": "Portuguese", "it": "Italian", "ru": "Russian",
    "th": "Thai", "vi": "Vietnamese", "ar": "Arabic", "hi": "Hindi",
    "id": "Indonesian", "ms": "Malay", "nl": "Dutch", "sv": "Swedish",
    "da": "Danish", "fi": "Finnish", "pl": "Polish", "cs": "Czech",
    "fil": "Filipino", "fa": "Persian", "el": "Greek", "hu": "Hungarian",
    "mk": "Macedonian", "ro": "Romanian", "tr": "Turkish",
}
SUPPORTED_LANGS = set(LANG_MAP.values())


def normalize_language(value, default):
    """ISO code or full name -> name the model accepts; unknown -> default (None = auto)."""
    raw = (value or "").strip()
    if not raw or raw.lower() in ("auto", "zh-auto"):
        return default
    low = raw.lower().replace("_", "-")
    if low in LANG_MAP:
        return LANG_MAP[low]
    if raw in SUPPORTED_LANGS:
        return raw
    if raw.capitalize() in SUPPORTED_LANGS:
        return raw.capitalize()
    return default


def build_app(loader, default_lang):
    """`loader` is called on the FIRST transcription request (lazy load), then stays resident."""
    from fastapi import FastAPI, File, Form, UploadFile
    from fastapi.responses import JSONResponse, FileResponse

    app = FastAPI(title="local-qwen3-asr", version="1.0")
    holder = {"model": None}
    lock = threading.Lock()
    voice_dir = _p(CFG["paths"].get("voice_share_dir") or os.path.join(HERE, "voice"))
    os.makedirs(voice_dir, exist_ok=True)

    # LOCAL PATCH (2026-10-24): the chat page fetches /last-voice from another loopback port;
    # without CORS the browser blocks it and the player never appears.
    @app.middleware("http")
    async def allow_local_cors(request, call_next):
        response = await call_next(request)
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Headers"] = "*"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        return response

    def get_model():
        if holder["model"] is None:
            with lock:
                if holder["model"] is None:
                    t0 = time.time()
                    holder["model"] = loader()
                    sys.stderr.write("[asr-server] model loaded in %.1fs\n" % (time.time() - t0))
        return holder["model"]

    @app.get("/voice/{name}")
    def voice_file(name: str):
        """Serve generated TTS audio so the chat UI can play it with <audio src=...>."""
        safe = os.path.basename(name)
        path = os.path.join(voice_dir, safe)
        if not os.path.isfile(path):
            return JSONResponse({"error": "not found"}, status_code=404)
        media = "audio/mpeg" if safe.lower().endswith(".mp3") else "audio/wav"
        return FileResponse(path, media_type=media)

    @app.get("/player")
    def player(file: str = "", caption: str = ""):
        """A tiny self-contained player page, embedded in chat as an iframe.

        Chromium's built-in media page autoplays and hides its chrome; this page shows a normal
        <audio controls preload="none"> so the player is visible and never starts by itself.
        """
        from fastapi.responses import HTMLResponse
        safe = os.path.basename(file or "")
        page = (
            "<!doctype html><html><head><meta charset='utf-8'>"
            "<style>html,body{margin:0;background:transparent;font:12px/1.4 system-ui,sans-serif;color:#23324F}"
            "audio{width:100%;height:34px;display:block;outline:none}"
            ".cap{opacity:.62;margin-top:4px}</style></head><body>"
            "<audio controls preload='none' src='/voice/" + safe + "'></audio>"
            + ("<div class='cap'>" + caption.replace("<", "&lt;") + "</div>" if caption else "")
            + "</body></html>"
        )
        return HTMLResponse(page)

    @app.get("/tts")
    def tts(text: str, voice: str = ""):
        """Offline text-to-speech via Windows SAPI (mp3, cached by text hash)."""
        import hashlib
        clean = (text or "").strip()[:800]
        if not clean:
            return JSONResponse({"error": "text is required"}, status_code=400)
        digest = hashlib.sha1((voice + "\x00" + clean).encode("utf-8")).hexdigest()[:16]
        mp3 = os.path.join(voice_dir, "tts-%s.mp3" % digest)
        if not os.path.isfile(mp3):
            txt = os.path.join(voice_dir, "tts-%s.txt" % digest)
            with open(txt, "w", encoding="utf-8") as f:
                f.write(clean)
            script = os.path.join(HERE, "sapi_tts.ps1")
            cmd = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, txt, mp3]
            if voice:
                cmd += ["-VoiceName", voice]
            try:
                subprocess.run(cmd, check=True, capture_output=True, timeout=120, creationflags=NO_WINDOW)
            except Exception as e:  # noqa: BLE001
                sys.stderr.write("[asr-server] sapi tts failed: %s\n" % e)
                return JSONResponse({"error": {"message": "tts failed: %s" % e}}, status_code=502)
            finally:
                try:
                    os.unlink(txt)
                except OSError:
                    pass
        # remember the latest spoken line so the chat can show a player at the end of the turn
        try:
            with open(os.path.join(voice_dir, "last.json"), "w", encoding="utf-8") as f:
                json.dump({"text": clean, "url": "/voice/tts-%s.mp3" % digest, "at": time.time()}, f, ensure_ascii=False)
        except OSError:
            pass
        return FileResponse(mp3, media_type="audio/mpeg")

    @app.get("/last-voice")
    def voice_last():
        """Last text passed to /tts (used by the client to render a per-turn player)."""
        path = os.path.join(voice_dir, "last.json")
        if not os.path.isfile(path):
            return JSONResponse({"text": "", "url": ""})
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            return JSONResponse({"text": "", "url": ""})
        return JSONResponse(data)

    @app.get("/health")
    def health():
        return {"status": "ok", "model": os.path.basename(DEF_MODEL),
                "ready": holder["model"] is not None,
                "note": "model loads lazily on the first transcription request"}

    @app.get("/v1/models")
    def models():
        return {"object": "list", "data": [{"id": "qwen3-asr-1.7b", "object": "model", "owned_by": "local"}]}

    @app.post("/v1/audio/transcriptions")
    async def transcribe(file: UploadFile = File(...), model_name: str = Form("", alias="model"),
                         language: str = Form(default_lang), response_format: str = Form("json")):
        suffix = os.path.splitext(file.filename or "a.wav")[1] or ".wav"
        raw = await file.read()
        fd, path = tempfile.mkstemp(suffix=suffix, dir=os.environ.get("TEMP", "."))
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(raw)
            lang = normalize_language(language, None if (default_lang or "").lower() in ("", "auto") else default_lang)
            model = get_model()
            t0 = time.time()
            # Qwen3-ASR's loader cannot decode every container (webm/opus from browsers fails);
            # normalise anything non-WAV through ffmpeg first.
            work = path
            conv = None
            if suffix.lower() != ".wav":
                conv = path + ".conv.wav"
                try:
                    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", path,
                                    "-ar", "16000", "-ac", "1", "-f", "wav", conv],
                                   check=True, capture_output=True, timeout=120, creationflags=NO_WINDOW)
                    work = conv
                except Exception as e:  # noqa: BLE001
                    sys.stderr.write("[asr-server] ffmpeg convert failed for %s: %s\n" % (suffix, e))
            try:
                r = model.transcribe(audio=[work], language=lang)
            except Exception as e:  # noqa: BLE001 - surface the reason to the caller, not a bare 500
                import traceback
                traceback.print_exc()
                return JSONResponse({"error": {"message": "transcribe failed: %s" % e}}, status_code=502)
            finally:
                if conv:
                    try:
                        os.unlink(conv)
                    except OSError:
                        pass
            text = (r[0].text or "").strip() if r else ""
            sys.stderr.write("[asr-server] %s bytes=%d -> %d chars in %.2fs\n"
                             % (os.path.basename(path), len(raw), len(text), time.time() - t0))
            if response_format == "text":
                from fastapi.responses import PlainTextResponse
                return PlainTextResponse(text)
            return JSONResponse({"text": text})
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass

    return app


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=DEF_MODEL)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=DEF_PORT)
    ap.add_argument("--language", default="Chinese", help="default language, 'auto' to detect")
    ap.add_argument("--device", default="cuda:0")
    a = ap.parse_args()

    import torch
    from qwen_asr import Qwen3ASRModel
    import uvicorn

    def loader():
        return Qwen3ASRModel.from_pretrained(a.model, dtype=torch.bfloat16, device_map=a.device,
                                             max_inference_batch_size=4, max_new_tokens=512)

    sys.stderr.write("[asr-server] listening http://%s:%d (model loads on first request)\n"
                     % (a.host, a.port))
    uvicorn.run(build_app(loader, a.language), host=a.host, port=a.port, log_level="warning")


if __name__ == "__main__":
    main()
