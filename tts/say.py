r"""say.py -- one-shot TTS with CosyVoice2 (speaker "me", seeded from a prompt wav).

For a single sentence this is enough, but every run reloads the model (~15 s).
For chat use, run tts_server.py instead: it keeps the model resident.

    .venv-tts\Scripts\python.exe tts\say.py --text "..." --out tts\out\a.mp3
"""
import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)


def _load_config():
    path = os.environ.get("DSH_VOICE_CONFIG") or os.path.join(REPO, "config", "config.json")
    if not os.path.isfile(path):
        path = os.path.join(REPO, "config", "config.example.json")
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


NO_WINDOW = 0x08000000 if os.name == 'nt' else 0

CFG = _load_config()


def _p(value):
    if not value:
        return ""
    return value if os.path.isabs(value) else os.path.join(REPO, value)


sys.path.insert(0, _p(CFG["paths"]["cosyvoice_code"]))
sys.path.insert(0, _p(CFG["paths"]["matcha_code"]))

from cosyvoice.cli.cosyvoice import CosyVoice2  # noqa: E402
import soundfile as sf  # noqa: E402
import torch  # noqa: E402


def load_wav(path, sr=16000):
    """torchaudio 2.11 routes load() through TorchCodec; use soundfile instead."""
    data, rate = sf.read(path, dtype="float32", always_2d=False)
    if data.ndim > 1:
        data = data.mean(axis=1)
    audio = torch.from_numpy(data)
    if rate != sr:
        import torchaudio.functional as af
        audio = af.resample(audio, rate, sr)
    return audio.unsqueeze(0)  # (1, n)


def save_wav(path, audio, sr):
    arr = audio.detach().cpu().numpy()
    if arr.ndim > 1:
        arr = arr[0]
    sf.write(path, arr, sr)

DEF_MODEL = _p(CFG["paths"]["cosyvoice_model"])
DEF_PROMPT = _p(CFG["paths"]["prompt_wav"])
DEF_PROMPT_TEXT = CFG.get("prompt_text", "希望你以后能够做的比我还好呦。")
SPK_ID = "me"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", required=True)
    ap.add_argument("--out", default=os.path.join(HERE, "out", "say.mp3"))
    ap.add_argument("--model", default=DEF_MODEL)
    ap.add_argument("--prompt", default=DEF_PROMPT)
    ap.add_argument("--prompt-text", default=DEF_PROMPT_TEXT)
    ap.add_argument("--fp16", action="store_true")
    ap.add_argument("--register", action="store_true", help="re-register the speaker from the prompt wav")
    a = ap.parse_args()

    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    model = CosyVoice2(a.model, load_jit=False, load_trt=False, fp16=a.fp16)

    spk_file = os.path.join(a.model, "spk2info.pt")
    if a.register or not os.path.isfile(spk_file):
        ok = model.add_zero_shot_spk(a.prompt_text, load_wav(a.prompt, 16000), SPK_ID)
        sys.stderr.write("[say] register speaker=%s ok=%s\n" % (SPK_ID, ok))
        try:
            model.save_spkinfo()
        except Exception as e:  # noqa: BLE001
            sys.stderr.write("[say] save spkinfo failed: %s\n" % e)

    wav = os.path.abspath(a.out) + ".wav"
    n = 0
    for j in model.inference_zero_shot(a.text, "", "", zero_shot_spk_id=SPK_ID, stream=False):
        save_wav(wav, j["tts_speech"], model.sample_rate)
        n += 1
        break
    if n == 0:
        sys.stderr.write("[say] no audio produced\n")
        return 2
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", wav, "-codec:a", "libmp3lame", "-b:a", "96k", a.out],
                   check=True, capture_output=True, creationflags=NO_WINDOW)
    try:
        os.remove(wav)
    except OSError:
        pass
    print(a.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
