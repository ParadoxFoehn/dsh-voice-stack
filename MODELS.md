# MODELS

两个必需模型 + 两个第三方代码仓库。总量约 **8.8 GB**，全部可从 ModelScope / GitHub 获取（脚本已封装）。

## 必需

### 1. Qwen3-ASR-1.7B —— 语音转文字

| 项 | 值 |
| --- | --- |
| 用途 | 语音输入；`verify.ps1` 的"读回来"自检；把 mp3 回读成文字来验证合成是否正常 |
| 来源 | ModelScope `Qwen/Qwen3-ASR-1.7B` |
| 体积 | **4.38 GB**（13 个文件） |
| 目录 | `models/Qwen3-ASR-1.7B/` |
| 许可 | Apache-2.0 |
| 显存 | 约 6.5 GB 峰值（fp16，1.7B） |

必需文件：

```
config.json  configuration.json  generation_config.json  preprocessor_config.json
chat_template.json  tokenizer_config.json  merges.txt  vocab.json
model.safetensors.index.json
model-00001-of-00002.safetensors   4024.8 MB
model-00002-of-00002.safetensors    456.0 MB
README.md
```

### 2. CosyVoice2-0.5B —— 文字转语音

| 项 | 值 |
| --- | --- |
| 用途 | 主要的"嗓子"；零样本音色克隆（一句参考音定音色） |
| 来源 | ModelScope `iic/CosyVoice2-0.5B` |
| 体积 | 全量 4.41 GB；**本包只下载必需部分 ≈ 3.9 GB** |
| 目录 | `models/CosyVoice2-0.5B/` |
| 许可 | Apache-2.0 |
| 显存 | 约 2.5–3.5 GB |

必需文件（`scripts/download-models.py` 会全部拉取）：

```
campplus.onnx                     27.0 MB    说话人嵌入
cosyvoice2.yaml                              模型结构 + 采样率 24000
configuration.json
flow.pt                          429.7 MB    flow matching
hift.pt                           79.5 MB    声码器
llm.pt                          1929.6 MB    语言模型主干（最大）
speech_tokenizer_v2.onnx         473.1 MB    语音分词器
README.md
CosyVoice-BlankEN/model.safetensors  942.3 MB  Qwen2.5-0.5B 底座（必需！）
CosyVoice-BlankEN/{config.json, generation_config.json, tokenizer_config.json,
                   merges.txt, vocab.json}
```

**刻意不下载**的文件（约 1.5 GB，只在流式/TensorRT/批处理时才需要）：

```
flow.cache.pt                       429.6 MB
flow.decoder.estimator.fp32.onnx    273.1 MB
flow.encoder.fp32.zip               183.5 MB
flow.encoder.fp16.zip               111.3 MB
speech_tokenizer_v2.batch.onnx      473.1 MB
```

## 必需（第三方代码，不是模型权重）

| 仓库 | 版本 | 目录 | 用途 |
| --- | --- | --- | --- |
| [FunAudioLLM/CosyVoice](https://github.com/FunAudioLLM/CosyVoice) | **tag `v2.0`** | `third_party/CosyVoice-2.0` | 推理代码 |
| [shivammehta25/Matcha-TTS](https://github.com/shivammehta25/Matcha-TTS) | main | `third_party/Matcha-TTS` | CosyVoice 依赖的 `matcha` 包（上游以 git submodule 提供，本包直接取源码） |

> ⚠️ **版本是最容易踩的坑**：CosyVoice 的 `main` 分支已经是 **CosyVoice 3** 的代码。用 main 配 CosyVoice2 权重，结果是"能跑、能出声、但说的字不对"（我们用 ASR 回读对比确认过）。必须用 `v2.0` 标签。

## 可选（只有想用 AI 生成封面时才需要）

| 模型 | 体积 | 说明 |
| --- | --- | --- |
| Qwen-Image 2.1（int8）+ qwen3vl-8b 文本编码 + VAE | ≈ 12.8 GB | ComfyUI 出图用；本包不含，与语音链路无关 |

## 下载

```powershell
.venv-asr\Scripts\python.exe scripts\download-models.py          # 两个都下
.venv-asr\Scripts\python.exe scripts\download-models.py --only asr
.venv-asr\Scripts\python.exe scripts\download-models.py --only tts
```

脚本特性：

- 已存在且非空的文件**跳过**（断点续传式重跑）
- 直接走 ModelScope 文件 API（无需登录、无需 HF）
- 会把 `CosyVoice-BlankEN` 子目录单独列出来下载（该子目录在文件列表里显示为 0 字节条目）

国内网络常见情况：ModelScope ≈ 20 MB/s；GitHub 直连可能不通，`install.ps1` 默认走 `https://gh-proxy.com/` 前缀，可用 `-GitHubProxy` 换。
