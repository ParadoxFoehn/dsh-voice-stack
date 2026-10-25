# 故障排查：症状 → 原因 → 处理

都是本机真实踩过的坑。按症状查。

## 装不起来 / 起不来

### `ModuleNotFoundError: No module named 'X'`
CosyVoice 的依赖链很散（`conformer` `diffusers` `HyperPyYAML` `omegaconf` `hydra-core` `librosa` `onnx` `onnxruntime` `pyworld` `inflect` `x-transformers` `wetext` `modelscope` `openai-whisper` `gdown` `matplotlib` `pyarrow` `wget` `lightning` `rich`）。
装 `tts/requirements.txt` 全量可覆盖；若是自己加的精简环境，缺哪个补哪个（`pip install X`）。

### `ModuleNotFoundError: No module named 'matcha'`
CosyVoice 上游用 git submodule 提供 Matcha-TTS。本包由 `install.ps1` 直接拉源码到 `third_party/Matcha-TTS`，服务里用 `sys.path` 挂上去。若目录缺失，重跑 `install.ps1 -Force`。

### `ImportError: cannot import name 'resolve_revision' from 'huggingface_hub'`
`diffusers` 新版要 `huggingface_hub>=1.0`，而 `transformers==4.51.3` 要 `<1.0`。本包把 `diffusers` 钉在 `0.29.0`、`huggingface_hub<1.0`。别让 pip 自作主张升级。

### `AttributeError: module 'numpy' has no attribute 'long'`
装了 `numpy 2.x`，但 `scipy`/`pyarrow` 的轮子是按 2.x 编译的，而 CosyVoice2 需要 1.x。解决：`numpy==1.26.4` + `scipy==1.13.1` + `scikit-learn==1.5.2` + `numba==0.60.0` + `pyarrow==17.0.0` 一起钉住。

### `RuntimeError: CUDA error: no kernel image is available for execution on the device`
显卡是 RTX 50 系（sm_120），但装的是 `cu121` 的 torch。必须用 **cu128** 轮子：
```
pip install torch==2.11.0 torchaudio==2.11.0 --index-url https://download.pytorch.org/whl/cu128
```

### `ImportError: TorchCodec is required for load_with_torchcodec`
torchaudio ≥2.9 的 `load()` 走 TorchCodec。本包已把音频读写改成 `soundfile`，并对 CosyVoice 的 `load_wav` 打了补丁（`scripts/patch-cosyvoice.py`，安装时自动执行）。若你手工换了代码目录，重跑一次那个脚本。

### `RuntimeError: D:\...\wetext\fsts\traditional_to_simplified.fst`（或 nagisa 读模型失败）
仓库路径里有中文/空格。把仓库移到纯 ASCII 路径，或建 junction：
```
cmd /c mklink /J D:\dsh-voice "D:\你的\中文路径\dsh-voice-stack"
```
然后用 `D:\dsh-voice` 里的脚本。

### `.ps1` 报语法错、中文全变成问号
PowerShell 5.1 把无 BOM 的 UTF-8 当 GBK 读。本包所有 `.ps1`/`.cmd` 都是**纯 ASCII**；你自己改的时候别往里写中文，或存成 UTF-8 **带 BOM**。

## 能跑但不对

### 能出声，但内容完全不对（ASR 回读是无关文字）
**CosyVoice 代码版本错了。** `main` 分支已经是 CosyVoice 3，必须用 **tag `v2.0`**：
```
https://codeload.github.com/FunAudioLLM/CosyVoice/tar.gz/refs/tags/v2.0
```
验证方法：合成「你好」，用 ASR 读回来，看是否一致。

### 声音机械、像念稿
默认参考音是系统 SAPI（`Microsoft Huihui Desktop`），音色本来就是合成的。想要自然人声：录 3–5 秒你自己的（或已授权的）16 kHz 单声道 WAV，替换 `assets/prompt.wav`，并把 `config/prompt_text` 改成**那段录音的原话**（必须逐字一致，否则音色会飘）。

### 播放器显示 `0:00 / 0:00`、点了没反应
1. 音频文件是否真的能取到：`curl -o NUL http://127.0.0.1:18081/say-file/<file>` 应 200；
2. 消息里 iframe 是否指向 `18081/player?file=…`（不是 `/say?…`）；
3. 跨端口取数据要 CORS —— 两个服务都已加 `Access-Control-Allow-Origin: *`。

### 播放器显示成一串代码
iframe/HTML **必须包在 `<div id="vcp-root">` 里**，消息渲染层才认。裸 iframe 会被当纯文本。

### 每轮回复下面自动冒出一条语音
插件里挂了 `conversation.chat.turnTail` 自动播放器。删掉那段注册（本包已不含）。

### 播放器和正文粘在一起
播放器容器要有下外边距（本包技能里写的是 `margin: 10px 0 18px`），并在播放器后空一行再写正文。

## 资源相关

### `torch.OutOfMemoryError: CUDA out of memory`（明明显存看着还够）
最常见：**ComfyUI / 另一个大模型应用**正占着显存。查：
```
nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader
```
ComfyUI 可以只卸载模型、不关进程：
```
curl -X POST http://127.0.0.1:8188/free -H "Content-Type: application/json" -d "{\"unload_models\":true,\"free_memory\":true}"
```
然后 `scripts\restart-guards.ps1`。碎片化严重时给服务加环境变量
`PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`。

### 每次合成都要等十几秒
说明模型没常驻。用 `tts_server.py`（常驻）而不是 `say.py`（每次重载）。第一次 15 秒左右正常，之后 1–3 秒。

### 反复弹出黑色命令提示符
某个子进程没加 `CREATE_NO_WINDOW`（ffmpeg / `cmd /c copy` / PowerShell）。本包已全部处理：Python 侧 `creationflags=CREATE_NO_WINDOW`，文件复制用 `shutil`，服务由守护经 WMI 脱离控制台启动。

### 服务莫名消失，日志里有 `forrtl: error (200) ... window-CLOSE`
服务是从控制台里起的子进程，控制台关了它也被带走。用 `guard-asr.ps1` 的 WMI 方式启动（本包默认），不要手动 `start` 后再关窗口。

## 诊断命令小抄

```powershell
# 两个服务活着吗
curl.exe -s http://127.0.0.1:18080/health
curl.exe -s http://127.0.0.1:18081/health

# 手动说一句，看返回字节数
curl.exe -s -o "$env:TEMP\t.mp3" -w "%{http_code} %{size_download}`n" "http://127.0.0.1:18081/say?text=%E4%BD%A0%E5%A5%BD"

# 读回来验证内容（需要 ASR 模型）
curl.exe -s -F "file=@$env:TEMP\t.mp3" http://127.0.0.1:18080/v1/audio/transcriptions

# 谁在占显存
nvidia-smi

# 日志
Get-Content logs\tts-server.log -Tail 30
Get-Content logs\asr-server.log -Tail 30
```
