r"""say.py -- local TTS with CosyVoice2 (fixed speaker "me", seeded from a prompt wav).

Run through the ASCII paths only (D:\py-tts, D:\py-asr):
    D:\py-asr\.venv\Scripts\python.exe D:\py-tts\say.py --text "..." --out D:\py-tts\out\a.mp3
"""
import argparse
import os
import subprocess
import sys

sys.path.insert(0, r"D:\py-tts\CosyVoice-2.0")
sys.path.insert(0, r"D:\py-tts\third_party\Matcha-TTS-main")

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

DEF_MODEL = r"D:\py-tts\models\CosyVoice2-0.5B"
DEF_PROMPT = r"D:\py-tts\assets\prompt.wav"
DEF_PROMPT_TEXT = "希望你以后能够做的比我还好呦。"
SPK_ID = "me"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", required=True)
    ap.add_argument("--out", default=r"D:\py-tts\out\say.mp3")
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
                   check=True)
    try:
        os.remove(wav)
    except OSError:
        pass
    print(a.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
