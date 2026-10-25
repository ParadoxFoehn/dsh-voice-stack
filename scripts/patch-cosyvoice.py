# -*- coding: utf-8 -*-
"""Patch CosyVoice's audio loader for torchaudio >= 2.9.

Why: torchaudio 2.9+ routes torchaudio.load() through TorchCodec, which is not
installed by the requirements and raises ImportError at the first inference call.
We read the WAV with soundfile instead (already a dependency) and accept tensor
inputs, which CosyVoice also passes in.

Idempotent: running twice is harmless.

    python scripts/patch-cosyvoice.py [--code third_party/CosyVoice-2.0]
"""
import argparse
import os
import re
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

NEW = '''def load_wav(wav, target_sr):
    # PATCHED by dsh-voice-stack: torchaudio 2.9+ loads through TorchCodec; use soundfile.
    import soundfile as sf
    import numpy as _np
    if isinstance(wav, str):
        data, sample_rate = sf.read(wav, dtype='float32', always_2d=False)
        if data.ndim > 1:
            data = data.mean(axis=1)
        speech = torch.from_numpy(data).unsqueeze(0)
        if sample_rate != target_sr:
            assert sample_rate > target_sr, 'wav sample rate {} must be greater than {}'.format(sample_rate, target_sr)
            speech = torchaudio.transforms.Resample(orig_freq=sample_rate, new_freq=target_sr)(speech)
        return speech
    if isinstance(wav, torch.Tensor):
        return wav if wav.dim() == 2 else wav.unsqueeze(0)
    if isinstance(wav, _np.ndarray):
        data = wav.mean(axis=1) if wav.ndim > 1 else wav
        return torch.from_numpy(data.astype('float32')).unsqueeze(0)
    raise TypeError('load_wav: unsupported input %r' % type(wav))
'''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--code", default=os.path.join(REPO_ROOT, "third_party", "CosyVoice-2.0"))
    a = ap.parse_args()
    path = os.path.join(a.code, "cosyvoice", "utils", "file_utils.py")
    if not os.path.isfile(path):
        print("not found: %s (skip)" % path)
        return 1
    src = open(path, "r", encoding="utf-8").read()
    if "PATCHED by dsh-voice-stack" in src:
        print("already patched: %s" % path)
        return 0
    out, n = re.subn(r"def load_wav\(wav, target_sr\):[\s\S]*?return speech\r?\n", NEW + "\n", src, count=1)
    if n != 1:
        print("pattern not found - CosyVoice layout changed? patch it manually (see docs\\troubleshooting.md)")
        return 1
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(out)
    print("patched: %s" % path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
