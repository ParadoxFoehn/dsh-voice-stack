# HARDWARE & SOFTWARE

## 实测环境（本包就是在这一台上调通的）

| 项 | 实测值 |
| --- | --- |
| OS | Windows 11 x64 |
| GPU | NVIDIA RTX 5090 Laptop，**24 GB** 显存，算力 **sm_120** |
| 驱动 / CUDA | 支持 CUDA 12.8 的驱动（torch 用 `cu128` 轮子） |
| RAM | 32 GB（模型加载峰值约 10 GB） |
| Python | 3.12.14 |
| ffmpeg | 在 PATH（wav ↔ mp3） |

实测数字（**0.6B 双模型档，v0.6.0 默认**）：

- ASR（Qwen3-ASR-**0.6B**）：首次加载 ≈ 2 s；转写 RTF ≈ 0.11；常驻显存 ≈ **2.3 GB**
- TTS（Qwen3-TTS-**0.6B**）：首次加载 ≈ 12 s；之后一句话 1–3 s；单实例常驻 ≈ **2.3 GB**（`gpu2` 双实例 ≈ **4.6 GB**）
- **两个都常驻合计 ≈ 4.6 GB** → **8 GB 显卡即可全套跑**（留约 3 GB 余量）；12 GB 以上更从容，可开双实例并行或再挂别的应用
- 想省显存：面板里把「驻留方式」改成空闲卸载，空闲 N 秒后模型自动卸载，回到 0

> 早期版本用过 ASR 1.7B（峰值 6.5 GB）+ CosyVoice2 0.5B（2.5–3.5 GB），合计约 10 GB；现在默认已换成两个 0.6B，显存需求**减半**。

## 最低要求

| 项 | 最低 | 说明 |
| --- | --- | --- |
| GPU | **8 GB 显存**即可全套常驻（两个 0.6B 合计 ≈4.6 GB）；**12 GB+ 更舒服**（可开 `gpu2` 双实例并行） | 分级方案见 [docs/HARDWARE-TIERS.md](docs/HARDWARE-TIERS.md) |
| 显卡架构 | sm_80 / sm_89 / sm_90 / sm_120 | **RTX 40 系用 `cu121` 轮子，RTX 50 系必须 `cu128`**（sm_120 在 cu121 里没有 kernel，会报 `no kernel image is available`） |
| RAM | **16 GB 起** | 模型权重加载峰值约 6 GB；8 GB 会非常紧 |
| 磁盘 | **约 14 GB** 空闲（安装期峰值约 18 GB） | 两个 venv 各 ≈5.5 GB + 两个 0.6B 模型 ≈2.5 GB |
| CPU-only | 可运行 | GPU 档位里选 `cpu`（CosyVoice2）；速度慢，适合没有 N 卡时先把链路跑通 |

## 软件清单

| 软件 | 版本 | 必需？ | 用途 / 安装 |
| --- | --- | --- | --- |
| Windows | 10 / 11 x64 | 必需 | 脚本是 PowerShell + `.cmd` |
| Python | **3.12**（3.11 / 3.13 理论可用） | 必需 | 两个 venv 都基于它；`py -3.12` 或 `python` |
| ffmpeg | 任意近期版本 | 必需 | wav ↔ mp3、任意格式音频转 16 kHz 单声道 |
| NVIDIA 驱动 | 支持 CUDA 12.8 | GPU 模式必需 | `nvidia-smi` 能跑即可 |
| PowerShell | 5.1 及以上 | 必需 | 安装/守护/自检脚本 |
| DSH 客户端（DeepSeek Harness） | 支持 bundle 插件 | 插件部分必需 | 提供 `#vcp-root` 渲染与 `tool.call.toolview` 槽位；只用服务、不做插件时可不需要 |
| tar.exe | Windows 10 1803+ 自带 | 必需 | 解压第三方源码 |
| ComfyUI | 可选 | 不需要 | 只有想用 Qwen-Image 生成封面时才用 |

## Python 依赖（关键版本，完整清单见 `asr/requirements.txt`、`tts/requirements.txt`）

| 包 | ASR 环境 | TTS 环境 | 备注 |
| --- | --- | --- | --- |
| torch / torchaudio | 2.11.0+cu128 | 2.11.0+cu128 | 按显卡架构选 cu121 / cu128 |
| transformers | 4.57.6 | **4.51.3** | TTS 侧必须 4.51.x（CosyVoice2 的代码年代） |
| numpy | 2.5.4 | **1.26.4** | TTS 侧必须 1.x，否则 scipy/pyarrow 轮子不兼容 |
| scipy / scikit-learn | 1.18 / 1.9 | **1.13.1 / 1.5.2** | 跟着 numpy 1.x 走 |
| numba / pyarrow | — | **0.60.0 / 17.0.0** | 同上 |
| qwen-asr | 0.0.6 | — | ASR 推理封装 |
| diffusers | — | 0.29.0 | CosyVoice 依赖 |
| onnxruntime | — | 1.31 | campplus / speech tokenizer |

> 两个环境**必须分开**：ASR 要新 numpy，TTS 要旧 numpy，装在一起必炸。

## 已知"看起来能跑但不对"的组合

| 组合 | 症状 |
| --- | --- |
| CosyVoice `main` 代码 + CosyVoice2 权重 | 能出声，但内容是乱码（ASR 回读是无关文字） |
| torch `cu121` + RTX 50 系 | `CUDA error: no kernel image is available for execution on the device` |
| numpy 2.x + CosyVoice2 | 导入期就崩（`np.long` / scipy / pyarrow 轮子报错） |
| transformers ≥4.57 + CosyVoice2 | `huggingface_hub` 版本冲突链，导入失败 |
| 仓库放在含中文的路径 | `wetext` 的 fst、`nagisa`、部分 onnx 运行时报"打不开文件" |
