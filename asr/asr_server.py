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
# 模型分档（用户 2026-10-30 定，别随手改回去）：
#   默认 0.6B  —— 日常语音聊天。显存 2.3 GB；60 s 清洗音频上与 1.7B 逐字相同，速度还快 5%。
#   1.7B       —— 只用于「会议录音转写」这类长音频、噪声/方言/术语多的场景，
#                 靠 `--model D:\py-asr\models\Qwen3-ASR-1.7B` 显式指定。占 4.7 GB。
#   ⚠️ 1.7B + TTS 0.6B + ollama 4B ≈ 12.5 GB，8 GB 卡必爆；默认走 0.6B 就是为了这个。
DEF_MODEL = os.path.join(HERE, "models", "Qwen3-ASR-0.6B")

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


def _pid_alive(pid):
    """父进程还活着吗（Windows：开了句柄再看退出码；拿不到就当活着，宁可多跑不要误杀）。"""
    if not pid:
        return True
    try:
        import ctypes
        k = ctypes.windll.kernel32
        h = k.OpenProcess(0x1000, False, int(pid))   # SYNCHRONIZE
        if not h:
            return False
        code = ctypes.c_ulong(0)
        k.GetExitCodeProcess(h, ctypes.byref(code))
        k.CloseHandle(h)
        return code.value == 259                     # STILL_ACTIVE
    except Exception:
        return True


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


def build_app(loader, default_lang, parent_pid=0, idle_s=0):
    """`loader` is called on the FIRST transcription request (lazy load), then stays resident.
    `parent_pid`：宿主插件进程；它一消失，本服务自杀（不留孤儿、不留显存）。
    `idle_s`：空闲多少秒后把模型卸掉（0 = 常驻）。"""
    from fastapi import FastAPI, File, Form, UploadFile
    from fastapi.responses import JSONResponse, FileResponse

    app = FastAPI(title="local-qwen3-asr", version="1.0")
    holder = {"model": None}
    ACTIVITY = {"at": 0.0, "busy": 0}
    lock = threading.Lock()
    voice_dir = os.path.join(HERE, "voice")
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

    def _watchdog():
        while True:
            time.sleep(5)
            if not _pid_alive(parent_pid):
                sys.stderr.write("[asr-server] parent %s gone -> exit\n" % parent_pid)
                sys.stderr.flush()
                os._exit(0)
            if idle_s and holder["model"] is not None:
                last = ACTIVITY["at"] or 0
                if last and (time.time() - last) > idle_s:
                    with lock:
                        holder["model"] = None
                    try:
                        import torch
                        torch.cuda.empty_cache()
                    except Exception:  # noqa: BLE001
                        pass
                    sys.stderr.write("[asr-server] idle %ss -> model unloaded\n" % idle_s)
                    sys.stderr.flush()

    if parent_pid or idle_s:
        threading.Thread(target=_watchdog, daemon=True).start()

    @app.post("/unload")
    def unload():
        """只卸模型、不杀进程 —— 给"模型要干活，先把显存腾出来"用（2026-10-30）。

        进程继续活着，所以下次用到不用冷启动；显存当场释放。
        正在转写时不打断（长音频可能跑十几秒），回 busy 让调用方稍后重试。
        """
        if ACTIVITY["busy"] > 0:
            return JSONResponse({"ok": False, "busy": True, "retry": 15}, status_code=409)
        before = 0
        before_free = None
        try:
            import torch
            before = torch.cuda.memory_allocated()
            before_free = torch.cuda.mem_get_info()[0]   # 驱动口径的可用显存，比分配器记账准
        except Exception:  # noqa: BLE001
            pass
        with lock:
            had = holder["model"] is not None
            holder["model"] = None
        freed = 0
        if had:
            try:
                # 先 gc 再 empty_cache：对象没死时清缓存只释放"空闲块"。
                import gc
                gc.collect()
                import torch
                torch.cuda.empty_cache()
                if before_free is not None:
                    freed = max(0, torch.cuda.mem_get_info()[0] - before_free)
                else:
                    freed = max(0, before - torch.cuda.memory_allocated())
            except Exception:  # noqa: BLE001
                pass
            sys.stderr.write("[asr-server] unload -> freed %d MB (driver view)\n" % (freed // 1048576))
            sys.stderr.flush()
        # device_map 加载的模型常被框架钩子引用住，卸完驱动侧往往只回一半；那就让进程退场，
        # 所有者下次用到会重新拉起（冷启动约 5 s）。判据用驱动口径，不用分配器记账。
        resp = {"ok": True, "unloaded": had, "freed_mb": int(freed // 1048576)}
        if had and before > 0 and freed < before * 0.5:
            resp["restart"] = True
            threading.Timer(1.5, lambda: os._exit(0)).start()
        return resp

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
                "lastUsed": ACTIVITY["at"],
                "note": "model loads lazily on the first transcription request"}

    @app.get("/v1/models")
    def models():
        return {"object": "list", "data": [{"id": "qwen3-asr-1.7b", "object": "model", "owned_by": "local"}]}

    @app.post("/v1/audio/transcriptions")
    async def transcribe(file: UploadFile = File(...), model_name: str = Form("", alias="model"),
                         language: str = Form(default_lang), response_format: str = Form("json")):
        suffix = os.path.splitext(file.filename or "a.wav")[1] or ".wav"
        raw = await file.read()
        ACTIVITY["busy"] += 1
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
            ACTIVITY["at"] = time.time()
            return JSONResponse({"text": text})
        finally:
            ACTIVITY["busy"] = max(0, ACTIVITY["busy"] - 1)
            try:
                os.unlink(path)
            except OSError:
                pass

    return app


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=DEF_MODEL)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=18080)
    ap.add_argument("--language", default="Chinese", help="default language, 'auto' to detect")
    ap.add_argument("--device", default="cuda:0")
    ap.add_argument("--parent-pid", type=int, default=0,
                    help="宿主插件 PID；它退出则本服务自杀（0 = 不管）")
    ap.add_argument("--idle-unload", type=int, default=0,
                    help="空闲 N 秒后卸载模型（0 = 常驻）")
    a = ap.parse_args()

    import torch
    from qwen_asr import Qwen3ASRModel
    import uvicorn

    def loader():
        return Qwen3ASRModel.from_pretrained(a.model, dtype=torch.bfloat16, device_map=a.device,
                                             max_inference_batch_size=4, max_new_tokens=512)

    sys.stderr.write("[asr-server] listening http://%s:%d (model loads on first request)\n"
                     % (a.host, a.port))
    uvicorn.run(build_app(loader, a.language, a.parent_pid, a.idle_unload),
                host=a.host, port=a.port, log_level="warning")


if __name__ == "__main__":
    main()
