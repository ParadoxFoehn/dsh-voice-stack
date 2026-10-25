# THIRD-PARTY NOTICES

本仓库（`plugin/`、`tts/`、`asr/`、`scripts/` 中的自有代码）采用 MIT 许可。
以下第三方组件**不随仓库分发**，由安装脚本按需下载；使用时请遵守各自的许可证。

## 模型

| 组件 | 来源 | 许可 | 备注 |
| --- | --- | --- | --- |
| **Qwen3-ASR-1.7B** | ModelScope `Qwen/Qwen3-ASR-1.7B`（阿里巴巴 / 通义） | **Apache-2.0** | 允许商用，需保留版权与许可声明 |
| **CosyVoice2-0.5B** | ModelScope `iic/CosyVoice2-0.5B`（阿里巴巴 / FunAudioLLM） | **Apache-2.0** | 同上 |

## 代码

| 组件 | 来源 | 许可 | 用途 |
| --- | --- | --- | --- |
| CosyVoice（tag `v2.0`） | github.com/FunAudioLLM/CosyVoice | **Apache-2.0** | CosyVoice2 推理代码 |
| Matcha-TTS | github.com/shivammehta25/Matcha-TTS | **MIT** | CosyVoice 依赖的 flow matching 组件 |
| Qwen2.5-0.5B（`CosyVoice-BlankEN` 子目录） | 随 CosyVoice2-0.5B 一起发布 | **Apache-2.0** | CosyVoice 的 LLM 主干底座 |

## 本机系统组件

| 组件 | 许可 | 用途 |
| --- | --- | --- |
| Windows SAPI（`System.Speech`，音色如 `Microsoft Huihui Desktop`） | 随 Windows 授权 | 生成 3–5 秒参考音（`assets/prompt.wav`）、以及 TTS 兜底 |
| ffmpeg | LGPL/GPL（视构建） | 音频转码 |

## 语音克隆的边界

CosyVoice 是**零样本音色克隆**模型：给它一段参考音，它就能用相近的音色说话。

- 默认参考音由系统 SAPI 合成，**不含任何真人声音**；
- 如果你换成自己的录音：请只使用**你本人**或已获得明确授权的声音；
- **不要**用他人的声音（含公众人物）做克隆后公开分发，这可能违反当地法律与平台规则。

## 我们在本包中做过的本地补丁

| 文件 | 改动 | 原因 |
| --- | --- | --- |
| `tts/say.py`、`tts/tts_server.py`、`asr/asr_server.py` | 路径全部来自 `config/config.json`；子进程加 `CREATE_NO_WINDOW` | 可移植；避免每次合成都闪一个黑色控制台 |
| `tts/say.py`、`tts/tts_server.py` | 音频读写走 `soundfile`，不用 `torchaudio.load/save` | torchaudio 2.11 起 `load()` 走 TorchCodec，未安装即报错 |
| `third_party/CosyVoice-2.0/cosyvoice/utils/file_utils.py` | `load_wav` 改用 soundfile，并兼容 tensor / ndarray 入参 | 同上；安装脚本会提示这一处需要打补丁（见 `docs/troubleshooting.md`） |
