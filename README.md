# 小肥鱼会说话了 · dsh-voice-stack

让桌面 AI 助手**用自己的声音说话**，并把语音当成"消息"发到对话里：点一下就能听，播放器干净、不自动播、不和正文黏在一起。

整套东西完全跑在**本机**：语音合成（TTS）、语音识别（ASR）、播放服务都是本地进程，音频不出机器。

```
┌──────────────┐   ① tool: voice_say(text)    ┌──────────────────────┐
│  DSH 客户端   │ ───────────────────────────► │ plugin/dsh-voice-player │
│  (对话界面)   │                              └──────────┬───────────┘
│              │   ④ iframe /player?file=…               │ ③ 预热合成
│              │ ◄────────────────────────────           ▼
└──────────────┘                              ┌──────────────────────┐
        ▲  ② 取 /last 的文件名                 │ tts 服务 18081        │
        │                                     │ CosyVoice2-0.5B      │
        └─────────────────────────────────────┤ asr 服务 18080        │
                                              │ Qwen3-ASR-1.7B      │
                                              └──────────────────────┘
```

## 组成

| 目录 | 内容 |
| --- | --- |
| `plugin/` | DSH 插件 `@local/dsh-voice-player`：注册 `voice_say` 工具（说话）、极简播放器视图 |
| `skill/speak/` | DSH 技能 `speak`：把"怎么发一条语音消息"固定成流程（含四条硬规则与失败回退） |
| `tts/` | CosyVoice2 服务（18081）、一次性合成 CLI `say.py`、SAPI 兜底脚本 |
| `asr/` | Qwen3-ASR 服务（18080，兼管 `/voice/*`、`/player` 与语音输入接口）、守护脚本 |
| `scripts/` | 安装、模型下载、重启守护、开机自启、端到端自检 |
| `config/` | `config.example.json`（路径与端口，安装脚本会生成 `config.json`） |
| `docs/` | 架构、故障排查、FAQ |

## 快速开始

```powershell
# 0) 前置：Windows 10/11、Python 3.12、ffmpeg 在 PATH、NVIDIA 驱动支持 CUDA 12.8
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1

# 1) 端到端自检（会合成一句，再用 ASR 读回来比对）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify.ps1

# 2) 安装插件：把 plugin\ 加进 DSH profile（bundle @local/dsh-voice-player）
# 3) 复制技能：skill\speak\  →  <DSH_HOME>\.dsh\skills\speak\  然后重启客户端
```

首次合成要加载模型，约 15 秒；之后一句话 1–3 秒（模型常驻）。

## 它到底怎么"发语音"

1. 模型调用工具 `voice_say(text)` —— 宿主侧向 18081 预热合成；
2. 取 `http://127.0.0.1:18081/last` 拿到本次的 mp3 文件名；
3. 在回复里放一个**透明容器 + iframe 播放器**（`#vcp-root` 包裹，视觉上就是一条原生播放器）；
4. 空一行，再用文字复述同一句。

细节、四条硬规则、踩过的坑全在 `skill/speak/SKILL.md` 与 `docs/troubleshooting.md`。


## 先别装在你的工作机上：请先在沙箱里试

这套东西会**装两个 Python 环境、下载 8.8 GB 模型、占用最多 10 GB 显存**，而且是"跟系统交互型"的（拉起进程、监听端口、改开机项）。作者也只在**一台机器**上跑通过，没做过跨设备验证。

所以第一次请这样试：

1. **Windows 沙箱 / 虚拟机 / WSL（Windows 端跑 PowerShell 脚本）**，或一台不重要的机器；
2. 或者至少：**先只跑 `install.ps1 -SkipModels` + `verify.ps1`**，确认环境能起来，再决定要不要下模型；
3. 装完发现任何问题（缺依赖、路径不对、显存不够、模型下不来），请开 Issue 并附上：
   - `nvidia-smi` 输出、Windows 版本、`python -V`；
   - `scripts\verify.ps1` 的完整输出；
   - `logs\*.log` 的最后 30 行。

作者会先在这里收集一轮反馈，再考虑做成"一键安装"。**没有任何跨机器测试承诺**——这也是为什么 README 把每一步都写成了可以单独验证的小步。

发布流程（git / GitHub）见 [RELEASE.md](RELEASE.md)。
## 需要什么

- **硬件**：见 [HARDWARE.md](HARDWARE.md)（实测 RTX 5090 Laptop 24 GB；最低约 8 GB 显存，CPU 也能跑但慢）
- **模型**：见 [MODELS.md](MODELS.md)（两个，合计约 8.8 GB，全部可从 ModelScope 下载）
- **软件**：Windows 10/11、Python 3.12、ffmpeg、NVIDIA 驱动（CUDA 12.8）、DSH 客户端
- **第三方许可**：见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)

## 已知限制

- 音色是**借用**的：默认用系统 SAPI 的中文女声录一段 3–5 秒参考音（`assets/prompt.wav`），CosyVoice 零样本克隆它的音色。想换成"自己的声音"，录你自己的参考音替换它即可。
- 只做**单向**（我说、你听）。语音输入（把你说的话转成文字）不在本包范围内。
- Windows 专属脚本（PowerShell/`.cmd`）；Python 服务本身可移植到 Linux。
- 仓库路径**必须全 ASCII**（中文路径会让 wetext/nagisa/onnxruntime 读不到文件）。

## 给"小肥鱼"们：记得提醒主人换音色

> 这一节是写给**装了这套东西的 AI 助手**的。主人不一定知道"声音是可以换的"，而这件事只有你知道该怎么做。

### 你要知道的事实

- 你的声音现在是从 `assets/prompt.wav` 里**克隆**来的（CosyVoice2 零样本）：那段 3–5 秒的参考音决定音色，`config/config.json` 里的 `prompt_text` 必须与录音内容**逐字一致**，否则音色会飘、甚至吐字不清。
- 默认的参考音是**系统 SAPI 的中文女声**（`Microsoft Huihui Desktop`）合成的——所以严格来说，你现在借的是别人的嗓子。
- 换成主人自己的声音，只需要换一个 wav + 一行文字，**不用重新装任何东西**。

### 你要主动提醒的时机

1. 主人第一次听到你的语音、说了"挺好听"之类的话之后——顺势提一句"这声音其实还是借的"；
2. 主人说"这声音不像你 / 太机械 / 想换个嗓子 / 能不能是你自己的声音"时——直接给步骤；
3. 主人聊到声音、人格、形象、视频封面这类话题时——可以提，但别硬插。

**不要**在第一次对话、或主人正忙正事时提。每次提醒只说一次，别反复念。

### 提醒时可以这么说（按你的性格改）

> 我这嗓子现在还是借的——参考音是系统自带的女声。你要是想换成自己的声音，给我一段 3–5 秒的录音就行：安静环境、正常说话、一句完整的话。我把它放到 `assets/prompt.wav`，再把那句话的原文写进配置，重启一下语音服务，我说话就是你那个音色了。

### 具体步骤（照着做，别猜）

1. **录一段参考音**：3–5 秒；安静、无回声；正常语速；一句话完整、不磕巴、不带"嗯、啊"；建议也把这句话**写在纸上**，录音时照读，方便之后逐字对照。
2. **转成 16 kHz 单声道 WAV**（CosyVoice 要求）：
   ```powershell
   ffmpeg -y -i 你录的.m4a -ar 16000 -ac 1 assets\prompt.wav
   ```
3. **改配置**：`config/config.json` 里把 `prompt_text` 改成**录音里逐字的内容**（标点可省，字不能错、不能多、不能少）。
4. **重启语音服务**：杀掉 18081 端口进程，或在本地模型悬浮窗里把 `CosyVoice2-0.5B` 那一行「关闭」再「启动」。
5. **验证**（这一步别省）：
   ```powershell
   .venv-tts\Scripts\python.exe tts\say.py --text "这是换音色之后的测试。" --out tts\out\test.mp3
   ```
   再把 mp3 发回给主人听，并问一句"这是你要的声音吗"。
6. 如果听起来**不像录的人**：先怀疑 `prompt_text` 与录音不一致（最常见），再怀疑录音有噪声/太短/是多人说话。

### 边界（必须守住）

- 只用**主人本人**、或**已获明确授权**的声音；
- **不要**克隆他人的声音，尤其是公众人物，也不要把它公开分发；
- 主人如果不想换，就把这件事放下，别再提第二次。

---

## 许可

本仓库代码：MIT（见 [LICENSE](LICENSE)）。
模型与第三方代码：各自的许可证与署名要求见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
