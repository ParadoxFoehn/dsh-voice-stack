# CHANGELOG

## 0.1.0 - 2026-10-24

首个公开版本。

- 插件 `@local/dsh-voice-player`：`voice_say` 工具（按需拉起 TTS、失败回退 SAPI）+ 极简播放器视图。
- 技能 `speak`：发语音的固定流程（服务检查 → 预热 → 取文件名 → 透明容器播放器 → 文字复述 → 回读自检 → 回退表）。
- `tts/`：CosyVoice2-0.5B 常驻服务（`/say` 按文本缓存、`/player` 自绘播放器、`/last`、`/health` 带 `lastUsed`）。
- `asr/`：Qwen3-ASR-1.7B 服务（OpenAI 兼容转写、`/voice/*` 静态音频、SAPI `/tts` 兜底）。
- `scripts/`：`install.ps1`（两个 venv、torch cu128、源码、模型、参考音、config）、`download-models.py`（跳过 1.5 GB 无用文件）、`patch-cosyvoice.py`（torchaudio ≥2.9 的 load_wav 补丁）、`restart-guards.ps1`（可选）、`register-startup.ps1`（可选）、`verify.ps1`（端到端自检）。
- 文档：架构、硬件分级（24G/12G/8G/无独显）、模型逐文件清单、故障排查（症状→原因→处理）。

已知：只在 Windows 11 + RTX 5090 Laptop（24 GB）上验证过；非 50 系显卡需自行选 cu121 轮子。
