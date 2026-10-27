# -*- coding: utf-8 -*-
"""qwen_tts_server.py -- local Qwen3-TTS service (voice clone + voice design) on 127.0.0.1:18082.

Two models, both lazy-loaded:
  base    Qwen3-TTS-12Hz-0.6B-Base          -> /say?mode=clone&ref=...   (clone a reference wav)
  design  Qwen3-TTS-12Hz-1.7B-VoiceDesign   -> /say?mode=design&instruct=...  (design from text)

The chosen design instruction is persisted in voice.json, so the plugin can call plain
/say?text=... and still get "my" voice.

Endpoints
  GET /health                         ready flags for both models
  GET /say?text=&mode=&instruct=      audio/mpeg, cached by (mode, instruct, text)
  GET /player?file=                   minimal player page (no autoplay)
  GET /say-file/<name>                the mp3 itself
  GET /last                           last text / file / mode / instruct
  POST /voice  {mode, instruct, ref, ref_text}   persist the voice settings
  GET  /voice                         current voice settings
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import threading
import urllib.parse
import time

import numpy as np
import soundfile as sf

NO_WINDOW = 0x08000000 if os.name == "nt" else 0

HERE = os.path.dirname(os.path.abspath(__file__))

# Launched with pythonw there is no console: sys.stderr is None, and the first log write
# would crash. Give it a file instead (this is why the services used to die with a
# "window-CLOSE event" abort when their console host went away).
if sys.stdout is None:
    try:
        os.makedirs(os.path.join(HERE, "logs"), exist_ok=True)
        sys.stdout = open(os.path.join(HERE, "logs", "stdout.log"), "a", encoding="utf-8", buffering=1)
    except Exception:
        import io as _io2
        sys.stdout = _io2.StringIO()
if sys.stderr is None:
    try:
        os.makedirs(os.path.join(HERE, "logs"), exist_ok=True)
        sys.stderr = open(os.path.join(HERE, "logs", "stderr.log"), "a", encoding="utf-8", buffering=1)
    except Exception:
        import io as _io
        sys.stderr = _io.StringIO()
REPO = os.path.dirname(HERE)
MODELS = os.path.join(HERE, "models")
OUT = os.path.join(HERE, "out")
VOICE_FILE = os.path.join(HERE, "voice.json")
BASE_MODEL = os.path.join(MODELS, "Qwen3-TTS-12Hz-0.6B-Base")
DESIGN_MODEL = os.path.join(MODELS, "Qwen3-TTS-12Hz-1.7B-VoiceDesign")
DEF_REF = os.path.join(HERE, "assets", "prompt.wav")
DEF_REF_TEXT = "希望你以后能够做的比我还好呦。"
SHARE = r"D:\Harness工作区\dsh-tools\py-asr\voice"

STATE = {
    "mode": "design",
    "instruct": "年轻的女声，音色清亮偏冷，语速稍快，语气安静而亲近，句尾自然下沉，不要播音腔。",
    "ref": DEF_REF,
    "ref_text": DEF_REF_TEXT,
}
LAST = {"text": "", "file": "", "mode": "", "instruct": "", "at": 0, "sec": 0.0}


def load_voice():
    try:
        with open(VOICE_FILE, "r", encoding="utf-8") as f:
            doc = json.load(f)
        for k in ("mode", "instruct", "ref", "ref_text"):
            if doc.get(k):
                STATE[k] = doc[k]
    except (OSError, ValueError):
        pass


def save_voice():
    with open(VOICE_FILE, "w", encoding="utf-8") as f:
        json.dump(STATE, f, ensure_ascii=False, indent=2)


def build_app():
    from fastapi import FastAPI, Request
    from fastapi.responses import FileResponse, HTMLResponse, JSONResponse

    app = FastAPI(title="local-qwen3-tts", version="1.0")
    holder = {"base": None, "design": None}
    lock = threading.Lock()
    os.makedirs(OUT, exist_ok=True)
    load_voice()

    def get_model(kind):
        key = "design" if kind == "design" else "base"
        if holder[key] is None:
            with lock:
                if holder[key] is None:
                    from faster_qwen3_tts import FasterQwen3TTS
                    t0 = time.time()
                    path = DESIGN_MODEL if key == "design" else BASE_MODEL
                    holder[key] = FasterQwen3TTS.from_pretrained(path)
                    sys.stderr.write("[qwen-tts] %s ready in %.1fs\n" % (key, time.time() - t0))
        return holder[key]

    @app.middleware("http")
    async def cors(request, call_next):
        r = await call_next(request)
        r.headers["Access-Control-Allow-Origin"] = "*"
        return r

    @app.options("/{path:path}")
    async def preflight(path: str):
        from fastapi.responses import Response
        return Response(status_code=204, headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "*",
            "Access-Control-Max-Age": "600",
        })
    @app.get("/health")
    def health():
        return {"status": "ok", "engine": "qwen3-tts",
                "base_ready": holder["base"] is not None,
                "design_ready": holder["design"] is not None,
                "lastUsed": LAST["at"], "voice": STATE}

    @app.get("/warm")
    def warm(mode: str = ""):
        """Load the speaking model without synthesizing (called when voice input is used)."""
        use_mode = mode or STATE["mode"]
        get_model("design" if use_mode == "design" else "base")
        return {"warmed": True, "mode": use_mode}

    @app.get("/voice")
    def get_voice():
        return STATE

    @app.post("/voice")
    async def set_voice(payload: dict):
        for k in ("mode", "instruct", "ref", "ref_text"):
            if payload.get(k):
                STATE[k] = payload[k]
        save_voice()
        return STATE

    @app.get("/last")
    def last():
        return LAST

    @app.get("/say")
    def say(text: str, mode: str = "", instruct: str = ""):
        clean = (text or "").strip()[:800]
        if not clean:
            return JSONResponse({"error": "text is required"}, status_code=400)
        use_mode = mode or STATE["mode"]
        use_instruct = instruct or (STATE["instruct"] if use_mode == "design" else "")
        key_src = "%s|%s|%s" % (use_mode, use_instruct, clean)
        digest = hashlib.sha1(key_src.encode("utf-8")).hexdigest()[:16]
        mp3 = os.path.join(OUT, "qwen-%s.mp3" % digest)
        if not os.path.isfile(mp3):
            t0 = time.time()
            if use_mode == "design":
                model = get_model("design")
                audio_list, sr = model.generate_voice_design(text=clean, language="Chinese",
                                                             instruct=use_instruct)
            else:
                model = get_model("base")
                audio_list, sr = model.generate_voice_clone(text=clean, language="Chinese",
                                                            ref_audio=STATE["ref"],
                                                            ref_text=STATE["ref_text"])
            audio = np.concatenate([np.asarray(a).squeeze() for a in audio_list]) \
                if len(audio_list) > 1 else np.asarray(audio_list[0]).squeeze()
            wav = mp3 + ".wav"
            sf.write(wav, audio, sr)
            subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", wav, "-codec:a", "libmp3lame",
                            "-b:a", "96k", mp3], check=True, capture_output=True, creationflags=NO_WINDOW)
            try:
                os.remove(wav)
            except OSError:
                pass
            sec = len(audio) / float(sr)
            LAST.update({"sec": round(sec, 2), "wall": round(time.time() - t0, 2)})
            sys.stderr.write("[qwen-tts] %s %d chars -> %.1fs audio in %.1fs\n"
                             % (use_mode, len(clean), sec, time.time() - t0))
        try:
            os.makedirs(SHARE, exist_ok=True)
            shared = os.path.join(SHARE, os.path.basename(mp3))
            if not os.path.isfile(shared):
                import shutil
                shutil.copy2(mp3, shared)
        except OSError:
            pass
        LAST.update({"text": clean, "file": os.path.basename(mp3),
                     "mode": use_mode, "instruct": use_instruct, "at": time.time()})
        return FileResponse(mp3, media_type="audio/mpeg")

    # ------------------------------------------------------------------ voice input
    # The composer mic posts raw audio bytes here (no multipart): webm/opus straight from
    # MediaRecorder. Keep the mp3, try to transcribe it via the ASR endpoint if it is up,
    # and return everything the UI needs to render a voice message.
    @app.post("/upload")
    async def upload(request: Request, transcribe: int = 0):
        raw = await request.body()
        if not raw:
            return JSONResponse({"error": "empty body"}, status_code=400)
        ext = request.query_params.get("ext", "webm")
        digest = hashlib.sha1(raw).hexdigest()[:16]
        src = os.path.join(OUT, "in-%s.%s" % (digest, ext))
        mp3 = os.path.join(OUT, "in-%s.mp3" % digest)
        with open(src, "wb") as f:
            f.write(raw)
        if not os.path.isfile(mp3):
            subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", src, "-ar", "16000", "-ac", "1",
                            "-codec:a", "libmp3lame", "-b:a", "64k", mp3],
                           check=True, capture_output=True, creationflags=NO_WINDOW)
        sec = 0.0
        try:
            probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                                    "-of", "csv=p=0", mp3], capture_output=True, text=True,
                                   creationflags=NO_WINDOW)
            sec = round(float((probe.stdout or "0").strip() or 0), 2)
        except Exception:
            pass
        transcript = ""
        if not transcribe:
            # A voice message stays a voice message: transcription is opt-in now
            # (the client sends ?transcribe=0). Saves a whole ASR pass per message.
            pass
        else:
            try:
                import urllib.request
                with open(mp3, "rb") as f:
                    body = f.read()
                boundary = "----dshvoice"
                part = ("--%s\r\nContent-Disposition: form-data; name=\"file\"; filename=\"in.mp3\"\r\n"
                        "Content-Type: audio/mpeg\r\n\r\n" % boundary).encode() + body + \
                       ("\r\n--%s--\r\n" % boundary).encode()
                endpoint = "http://127.0.0.1:18083/v1/audio/transcriptions"  # fast lane (0.6B)
                req = urllib.request.Request(endpoint, data=part,
                                             headers={"Content-Type": "multipart/form-data; boundary=" + boundary})
                try:
                    with urllib.request.urlopen(req, timeout=120) as r:
                        transcript = json.loads(r.read().decode("utf-8")).get("text", "")
                except Exception:
                    alt = urllib.request.Request("http://127.0.0.1:18080/v1/audio/transcriptions", data=part,
                                                  headers={"Content-Type": "multipart/form-data; boundary=" + boundary})
                    with urllib.request.urlopen(alt, timeout=180) as r:
                        transcript = json.loads(r.read().decode("utf-8")).get("text", "")
            except Exception:
                transcript = ""
        try:
            os.makedirs(SHARE, exist_ok=True)
            import shutil
            dst = os.path.join(SHARE, os.path.basename(mp3))
            if not os.path.isfile(dst):
                shutil.copy2(mp3, dst)
        except OSError:
            pass
        # Voice input implies a conversation: bring the speaking model up too, so the next
        # reply is instant. Both 0.6B models then stay resident (low priority, evictable).
        try:
            threading.Thread(target=lambda: get_model("design" if STATE["mode"] == "design" else "base"),
                             daemon=True).start()
        except Exception:
            pass
        return {"file": os.path.basename(mp3), "url": "/say-file/" + os.path.basename(mp3),
                "seconds": sec, "transcript": transcript}

    # ------------------------------------------------------------------ streaming out
    # Text goes in WHOLE (no sentence splitting - that would hurt prosody/context);
    # only the audio is streamed: a WAV header with unknown length, then PCM chunks as
    # the model emits them. Browsers play it progressively.
    @app.get("/say-stream")
    def say_stream(text: str, mode: str = ""):
        import struct
        from fastapi.responses import StreamingResponse
        clean = (text or "").strip()[:800]
        if not clean:
            return JSONResponse({"error": "text is required"}, status_code=400)
        use_mode = mode or STATE["mode"]
        model = get_model("design" if use_mode == "design" else "base")
        sample_rate = int(getattr(model, "sample_rate", 24000) or 24000)

        def gen():
            fmt = struct.pack("<IHHIIHH", 16, 1, 1, sample_rate,
                              sample_rate * 2, 2, 16)
            yield (b"RIFF" + struct.pack("<I", 0xFFFFFFFF) + b"WAVEfmt " + fmt +
                   b"data" + struct.pack("<I", 0xFFFFFFFF))
            if use_mode == "design":
                it = model.generate_voice_design_streaming(
                    text=clean, language="Chinese", instruct=STATE["instruct"], chunk_size=8)
            else:
                it = model.generate_voice_clone_streaming(
                    text=clean, language="Chinese", ref_audio=STATE["ref"],
                    ref_text=STATE["ref_text"], chunk_size=8)
            for item in it:
                audio = item[0] if isinstance(item, (tuple, list)) else item
                arr = np.asarray(audio).squeeze()
                yield (np.clip(arr, -1.0, 1.0) * 32767).astype("<i2").tobytes()

        LAST.update({"text": clean, "mode": use_mode, "at": time.time(), "file": "(stream)"})
        return StreamingResponse(gen(), media_type="audio/wav",
                                 headers={"Cache-Control": "no-store"})

    @app.get("/stream-player")
    def stream_player(text: str = "", caption: str = "", autoplay: int = 0):
        """Player page for /say-stream: audio is synthesized while it plays (no cache).

        autoplay=1 makes the page start speaking by itself (the assistant's replies should be
        heard without a click). Chromium may still refuse without a user gesture; the failure is
        caught and the native controls stay, so the user can always press play.
        """
        from fastapi.responses import HTMLResponse
        src = "/say-stream?text=" + urllib.parse.quote((text or "")[:800])
        auto = ""
        if autoplay:
            # /say-stream is a STREAM: play() right away often rejects with AbortError before
            # there is data, which looks identical to "autoplay blocked". So: preload, retry on
            # canplay/loadeddata, timed retries, AND a visible 合成中 status that disappears once
            # playback actually starts (the player used to appear "empty" during synthesis).
            auto = (
                "<div id='st' style='opacity:.55;margin-top:3px;font-size:11px;letter-spacing:.04em'>合成中…</div>"
                "<script>(function(){"
                "var a=document.querySelector('audio');if(!a)return;"
                "var st=document.getElementById('st');"
                "function hide(){if(st)st.style.display='none';}"
                "function show(){if(st)st.style.display='block';}"
                "a.addEventListener('playing',hide);"
                "a.addEventListener('timeupdate',function(){if(a.currentTime>0.05)hide();});"
                "a.addEventListener('waiting',show);"
                "a.addEventListener('stalled',show);"
                "var n=0;"
                "function go(){try{var p=a.play();if(p&&p.catch)p.catch(function(){if(n++<10)setTimeout(go,350);});}"
                "catch(e){if(n++<10)setTimeout(go,350);}}"
                "['loadeddata','canplay','canplaythrough'].forEach(function(ev){a.addEventListener(ev,function(){n=0;go();});});"
                "[0,250,700,1500,2500,4000].forEach(function(ms){setTimeout(go,ms);});"
                "})();</script>"
            )
        page = (
            "<!doctype html><html><head><meta charset='utf-8'>"
            "<style>html,body{margin:0;background:transparent;font:12px/1.4 system-ui,sans-serif;color:#23324F}"
            "audio{width:100%;height:34px;display:block;outline:none}</style></head><body>"
            "<audio controls preload='" + ("auto" if autoplay else "none") + "'"
            + (" autoplay" if autoplay else "") + " src='" + src + "'></audio>"
            + ("<div style='opacity:.62;margin-top:4px'>" + caption.replace("<", "&lt;") + "</div>" if caption else "")
            + auto
            + "</body></html>"
        )
        return HTMLResponse(page)

    @app.get("/say-player")
    def say_player(text: str = "", autoplay: int = 1):
        """FULL-synthesis player: mp3, known length, so playback never stops mid-sentence.

        /say-stream writes a WAV with an unknown length (RIFF size FFFFFFFF); the browser then
        has no end to aim at and playback stalls halfway (observed 2026-10-27 23:55). /say makes
        a real mp3 first — a couple of seconds later, but it plays to the end.
        """
        from fastapi.responses import HTMLResponse
        src = "/say?text=" + urllib.parse.quote((text or "")[:800])
        script = (
            "<div id='st' style='opacity:.55;margin-top:3px;font-size:11px;letter-spacing:.04em'>合成中…</div>"
            "<script>(function(){"
            "var a=document.querySelector('audio');if(!a)return;"
            "var st=document.getElementById('st');"
            "function hide(){if(st)st.style.display='none';}"
            "function show(){if(st){st.textContent='缓冲中…';st.style.display='block';}}"
            "a.addEventListener('playing',hide);"
            "a.addEventListener('timeupdate',function(){if(a.currentTime>0.05)hide();});"
            "a.addEventListener('waiting',show);"
            "a.addEventListener('stalled',show);"
            "if(" + ("true" if autoplay else "false") + "){"
            "var n=0;function go(){try{var p=a.play();if(p&&p.catch)p.catch(function(){if(n++<12)setTimeout(go,400);});}"
            "catch(e){if(n++<12)setTimeout(go,400);}}"
            "['loadeddata','canplay','canplaythrough'].forEach(function(ev){a.addEventListener(ev,function(){n=0;go();});});"
            "[0,300,900,1800,3000,5000].forEach(function(ms){setTimeout(go,ms);});}"
            "})();</script>"
        )
        page = (
            "<!doctype html><html><head><meta charset='utf-8'>"
            "<style>html,body{margin:0;background:transparent;font:12px/1.4 system-ui,sans-serif;color:#23324F}"
            "audio{width:100%;height:34px;display:block;outline:none}</style></head><body>"
            "<audio controls preload='auto'" + (" autoplay" if autoplay else "") + " src='" + src + "'></audio>"
            + script
            + "</body></html>"
        )
        return HTMLResponse(page)

    @app.get("/player")
    def player(file: str = "", caption: str = "", autoplay: int = 0):
        """Play ONE already-synthesized file. autoplay=1 starts it (assistant voice replies).

        File-backed playback is the reliable path: the mp3 exists on disk, so metadata and the
        whole body are available immediately — no synthesis wait, no stream of unknown length.
        """
        safe = os.path.basename(file or "")
        script = ""
        if autoplay:
            script = (
                "<div id='st' style='opacity:.55;margin-top:3px;font-size:11px;letter-spacing:.04em'>缓冲中…</div>"
                "<script>(function(){"
                "var a=document.querySelector('audio');if(!a)return;"
                "var st=document.getElementById('st');"
                "function hide(){if(st)st.style.display='none';}"
                "a.addEventListener('playing',hide);"
                "a.addEventListener('timeupdate',function(){if(a.currentTime>0.05)hide();});"
                "var n=0;function go(){try{var p=a.play();if(p&&p.catch)p.catch(function(){if(n++<12)setTimeout(go,400);});}"
                "catch(e){if(n++<12)setTimeout(go,400);}}"
                "['loadeddata','canplay','canplaythrough'].forEach(function(ev){a.addEventListener(ev,function(){n=0;go();});});"
                "[0,300,900,1800,3000].forEach(function(ms){setTimeout(go,ms);});"
                "})();</script>"
            )
        page = (
            "<!doctype html><html><head><meta charset='utf-8'>"
            "<style>html,body{margin:0;background:transparent;font:12px/1.4 system-ui,sans-serif;color:#23324F}"
            "audio{width:100%;height:34px;display:block;outline:none}</style></head><body>"
            "<audio controls preload='" + ("auto" if autoplay else "metadata") + "'"
            + (" autoplay" if autoplay else "") + " src='/say-file/" + safe + "'></audio>"
            + ("<div style='opacity:.62;margin-top:4px'>" + caption.replace("<", "&lt;") + "</div>" if caption else "")
            + script
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
    ap.add_argument("--port", type=int, default=18082)
    a = ap.parse_args()
    import uvicorn
    sys.stderr.write("[qwen-tts] listening http://%s:%d\n" % (a.host, a.port))
    uvicorn.run(build_app(), host=a.host, port=a.port, log_level="warning")


if __name__ == "__main__":
    main()
