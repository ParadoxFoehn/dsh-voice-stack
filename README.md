# 小肥鱼会说话了 · dsh-voice-stack（v0.2.0）

让桌面 AI 助手**有自己的嗓子、能听懂你的话、并且用"消息"的方式收发语音**：
你按住说一句 → 它以气泡收下；它想回你 → **消息一到就开口说一次**，说完不再吵，想重听点卡片。

整套东西完全跑在**本机**：TTS、ASR、播放服务都是本地进程，音频不出机器。

```
用户说 ──► 声波按钮 ──► /upload ──► 【语音 N.Ns】url ──► 待发托盘（最多 3 条）
                                                        │
                                        发送 ──► /voice-player/probe-send
                                                        │
                          sessionController.prompt()（官方"用户发消息"入口）
                                                        ▼
                                          会话里出现一条用户消息 ──► 气泡（原生 <audio>）

助手说 ──► voice_say(text) ──► /say 整段合成 mp3 ──► lastVoice
                                                        │
                                客户端 1.2 s 轮询 /voice-player/last-voice
                                                        ▼
                        没播过？挂一个游离 <audio> ──► 自动播一次 ──► ended 写记号 + 撕掉
                                                    消息里留白卡（/player?file=…）供重听
```

## 组成

| 目录 | 内容 |
| --- | --- |
| `plugin/` | DSH 插件 `@local/dsh-voice-player`：宿主半边（`voice_say` 工具 + 5 个路由 + 三行回话规则）与 web 半边（声波按钮 / 待发托盘 / 气泡渲染 / 一次性播放器） |
| `tts/` | Qwen3-TTS 服务（18082）：整段 `/say`、流式 `/say-stream`、三种播放页、`/upload` 接用户录音、`/warm` 预热 |
| `asr/` | Qwen3-ASR 服务（OpenAI 兼容 `/v1/audio/transcriptions`）：18083 快道（0.6B）/ 18080 长音（1.7B） |
| `skill/speak/` | 技能 `speak`：怎么"用好"这把嗓子（服务检查 → 预热 → 说短话 → 文字补细节） |
| `scripts/` | 安装、模型下载、守护、自检 |
| `docs/` | 架构（`architecture.md`）、故障排查、硬件分级 |

## 快速开始

```powershell
# 0) 前置：Windows 10/11、Python 3.12、ffmpeg 在 PATH、NVIDIA 驱动支持 CUDA 12.8
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1      # 两个 venv + 模型 + 参考音

# 1) 端到端自检（合成一句 → 再读回来比对）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify.ps1

# 2) 安装插件：把 plugin\ 加进 DSH profile（bundle @local/dsh-voice-player）
# 3) 复制技能：skill\speak\ → <DSH_HOME>\.dsh\skills\speak\，然后重启客户端
```

首次合成要加载模型（约 12.7 s）；`/warm` 之后，一句话 ≈ 时长 × 0.31–0.38 秒。

## 配置（`plugin/client.js` 顶部，改完重启客户端）

| 常量 | 默认 | 含义 |
| --- | --- | --- |
| `MAX_DRAFTS` | `3` | 待发托盘最多攒几条，满了拒绝新录音并提示 |
| `MAX_SECONDS` | `30` | 单条录音硬上限（秒），到点自动停止 |
| `WARN_SECONDS` | `20` | 开始提示"偏长"（不打断） |

音色在 `tts/voice.json`（`mode: clone|design`、`instruct`、`ref`、`ref_text`），换嗓子见 `MODELS.md` §1。

## 三个"为什么这么设计"

1. **用户语音不走输入框**：直接调 `sessionController.prompt()`（和定时提醒同一扇门）。所以没有"文字闪进输入框""发送后残留""连发被顶掉"这些问题。
2. **助手语音整段合成 mp3，不用流式 WAV**：流式 WAV 的头长度是 `FFFFFFFF`，浏览器没有终点，会**播到一半停住**（实测）。宁慢 2 秒，也要能听完。
3. **一次性播放器放在插件层，不放消息里**：消息列表虚拟化，滚出视口就卸载——放在消息里的 `<audio>`/iframe 会重载、从头播。放在插件层就与滚动无关。

## 必备的环境常识（踩过的坑）

- **中文路径会炸 C++ 依赖**：`D:\py-tts`、`D:\py-asr` 是指向工作区的 ASCII junction，服务必须从 junction 启动。
- **服务不要挂在当前终端**：用 WMI `Win32_Process.Create` 拉起，否则宿主一退服务就死。
- **别用 `Set-Content -Encoding UTF8` 写配置**（会加 BOM，DSH 客户端直接起不来）。
- **`<audio>` 标签会被消息渲染层过滤**：所以气泡里的播放器是插件**用 DOM 造出来的原生元素**，不是模型输出的 HTML。

细节全在 [`docs/architecture.md`](docs/architecture.md) 与 [`docs/troubleshooting.md`](docs/troubleshooting.md)。

## 先别装在你的工作机上：请先在沙箱里试

这套东西会**装两个 Python 环境、下载约 12 GB 模型、占用最多 10 GB 显存**，而且是"跟系统交互型"的（拉起进程、监听端口、改开机项）。作者只在**一台机器**（Windows + RTX 5090 Laptop 24 GB）上跑通过，没做过跨设备验证。

建议顺序：沙箱机 → 只跑 `verify.ps1` → 跑通再装插件。

## 已知限制

- 只在 Windows + RTX 5090 Laptop（24 GB）实测；12 GB 以下需要换更小模型或走 CPU（见 `docs/HARDWARE-TIERS.md`）。
- 单条录音上限 30 s；0.6B ASR 的硬边界约 60 s（`max_source_positions=1500`）。
- `plugin/client.js` 留有 0.1/试探期的遗留代码（旧 DOM 扫描、未使用的 `VoiceBubble`/`clickSendButton`），不影响运行。
- 自动播放受浏览器策略约束：被拒时**静默失败**，消息里的白卡仍可点播。

## 许可

代码 MIT；模型各自遵循其原始许可（Apache-2.0 等），见 `THIRD-PARTY-NOTICES.md`。
