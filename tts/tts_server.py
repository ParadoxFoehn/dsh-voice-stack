r"""tts_server.py -- local CosyVoice2 TTS HTTP service.

Why: say.py reloads the model on every call (~20 s per sentence). This service keeps it
resident after the first request, so a sentence costs ~1-3 s afterwards.

Run (ASCII junction only):
    D:\py-tts\tts-server.cmd            -> http://127.0.0.1:18081

Endpoints:
    GET /health                  -> {"ready": bool}
    GET /say?text=...            -> audio/mpeg (cached by text hash)
    GET /player?file=<name>      -> tiny HTML page with <audio controls preload=none>
    GET /last                    -> {"text": "...", "url": "/voice/<name>.mp3"}
"""
import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import threading
import time

# Never flash a console window for helper processes (user complaint 2026-10-24).
NO_WINDOW = 0x08000000 if os.name == "nt" else 0

sys.path.insert(0, r"D:\py-tts\CosyVoice-2.0")
sys.path.insert(0, r"D:\py-tts\third_party\Matcha-TTS-main")

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
DEF_MODEL = r"D:\py-tts\models\CosyVoice2-0.5B"
DEF_PROMPT = r"D:\py-tts\assets\prompt.wav"
DEF_PROMPT_TEXT = "希望你以后能够做的比我还好呦。"
OUT = os.path.join(HERE, "out")
SHARE = r"D:\Harness工作区\dsh-tools\py-asr\voice"  # served by the ASR endpoint as /voice/*
LAST = {"text": "", "file": "", "at": 0}


def build_app(model_dir, prompt, prompt_text, fp16):
    from fastapi import FastAPI
    from fastapi.responses import FileResponse, HTMLResponse, JSONResponse

    app = FastAPI(title="local-cosyvoice2", version="1.0")
    holder = {"model": None}
    lock = threading.Lock()

    def get_model():
        if holder["model"] is None:
            with lock:
                if holder["model"] is None:
                    from cosyvoice.cli.cosyvoice import CosyVoice2
                    from cosyvoice.utils.file_utils import load_wav
                    t0 = time.time()
                    m = CosyVoice2(model_dir, load_jit=False, load_trt=False, fp16=fp16)
                    m.add_zero_shot_spk(prompt_text, load_wav(prompt, 16000), "me")
                    holder["model"] = m
                    sys.stderr.write("[tts] model ready in %.1fs\n" % (time.time() - t0))
        return holder["model"]

    @app.middleware("http")
    async def cors(request, call_next):
        r = await call_next(request)
        r.headers["Access-Control-Allow-Origin"] = "*"
        return r

    @app.get("/health")
    def health():
        return {"status": "ok", "ready": holder["model"] is not None,
                "lastUsed": LAST.get("at", 0),
                "note": "model loads on the first /say request"}

    @app.get("/last")
    def last():
        return LAST

    @app.get("/say")
    def say(text: str, force: bool = False):
        clean = (text or "").strip()[:800]
        if not clean:
            return JSONResponse({"error": "text is required"}, status_code=400)
        os.makedirs(OUT, exist_ok=True)
        digest = hashlib.sha1(clean.encode("utf-8")).hexdigest()[:16]
        mp3 = os.path.join(OUT, "say-%s.mp3" % digest)
        if force or not os.path.isfile(mp3):
            m = get_model()
            t0 = time.time()
            wav = mp3 + ".wav"
            got = False
            for j in m.inference_zero_shot(clean, "", "", zero_shot_spk_id="me", stream=False):
                audio = j["tts_speech"].squeeze().cpu().numpy()
                sf.write(wav, audio, m.sample_rate)
                got = True
                break
            if not got:
                return JSONResponse({"error": "no audio produced"}, status_code=502)
            subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", wav, "-codec:a", "libmp3lame",
                            "-b:a", "96k", mp3], check=True,
                           capture_output=True, creationflags=NO_WINDOW)
            try:
                os.remove(wav)
            except OSError:
                pass
            sys.stderr.write("[tts] %d chars -> %s in %.1fs\n" % (len(clean), os.path.basename(mp3), time.time() - t0))
        # mirror into the shared dir so the ASR endpoint can serve it to the chat (/voice/*)
        try:
            os.makedirs(SHARE, exist_ok=True)
            shared = os.path.join(SHARE, os.path.basename(mp3))
            if not os.path.isfile(shared):
                try:
                    shutil.copy2(mp3, shared)  # no cmd.exe, so no console flash
                except OSError:
                    pass
            LAST["text"] = clean
            LAST["file"] = os.path.basename(mp3)
            LAST["at"] = time.time()
        except OSError:
            pass
        return FileResponse(mp3, media_type="audio/mpeg")

    @app.get("/player")
    def player(file: str = "", caption: str = ""):
        safe = os.path.basename(file or "")
        page = (
            "<!doctype html><html><head><meta charset='utf-8'>"
            "<style>html,body{margin:0;background:transparent;font:12px/1.4 system-ui,sans-serif;color:#23324F}"
            "audio{width:100%;height:34px;display:block;outline:none}.cap{opacity:.62;margin-top:4px}</style></head><body>"
            "<audio controls preload='metadata' src='/say-file/" + safe + "'></audio>"
            + ("<div class='cap'>" + caption.replace("<", "&lt;") + "</div>" if caption else "")
            + "</body></html>"
        )
        return HTMLResponse(page)

    @app.get("/say-file/{name}")
    def say_file(name: str):
        safe = os.path.basename(name)
        path = os.path.join(OUT, safe)
        if not os.path.isfile(path):
            return JSONResponse({"error": "not found"}, status_code=404)
        return FileResponse(path, media_type="audio/mpeg")

    return app


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=18081)
    ap.add_argument("--model", default=DEF_MODEL)
    ap.add_argument("--prompt", default=DEF_PROMPT)
    ap.add_argument("--prompt-text", default=DEF_PROMPT_TEXT)
    ap.add_argument("--fp16", action="store_true")
    a = ap.parse_args()
    import uvicorn
    sys.stderr.write("[tts] listening http://%s:%d (model loads on first /say)\n" % (a.host, a.port))
    uvicorn.run(build_app(a.model, a.prompt, a.prompt_text, a.fp16),
                host=a.host, port=a.port, log_level="warning")


if __name__ == "__main__":
    main()
