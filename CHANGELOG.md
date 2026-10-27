# CHANGELOG

## 0.2.0 - 2026-10-28

这一版把"语音"从**能说话**做到了**能对话**：用户发语音 → 助手回语音，两头都是消息流里的原生音频。

### 语音输入（用户 → 助手）

- 输入框左侧**声波按钮**：点一下先探活语音服务（没起就自动拉起并显示等待秒数），起来直接录音；再点结束。
- 录音送 `POST /upload?ext=webm&transcribe=0`（webm/opus 原始字节 → ffmpeg 转 16k 单声道 mp3），返回 `{url, seconds}`，并生成标记 `【语音 N.Ns】http://127.0.0.1:18082/say-file/x.mp3`。
- 录音进**待发托盘**（右下角浮层）：可逐条试听、`×` 撤回、一次「发送 N 条」。上限 `MAX_DRAFTS=3`。
- **不经过输入框**：发送走宿主路由 `GET /voice-player/probe-send?text=…` → `sessionController.prompt()`（与定时提醒同一扇门）→ 生成 user 角色消息 → `agent.followup()`。因此不存在"文字闪进输入框""发送后残留在框里""连发被顶掉"这些老问题。
- 单条录音硬上限 `MAX_SECONDS=30`（到点自动停止），`WARN_SECONDS=20` 起提示偏长。
- 消息渲染：**标记 → 原生 `<audio>` 气泡**（白卡 + 淡蓝描边），一条消息里几个标记就出几个气泡，支持带"转写：…"的尾部。

### 语音输出（助手 → 用户）

- `voice_say(text)`：宿主导入 `ensureTts()`（探活 → WMI 拉起）→ 调 `/say` **整段合成** mp3（按文本摘要缓存）→ 读 `/last` 得到 `{file, sec, ...}`。
- 客户端每 1.2 s 轮询 `GET /voice-player/last-voice`：**没播过**的文件就挂一个游离 `<audio>`，自动播放**一次**，`ended` 时移除元素并把文件名写进 `localStorage['dsh-voice-played']`。
  - 判据是"**播完才做记号**"，不是时间窗；加载失败**不做记号**，宁可下次再响。
  - 播放器活在插件层，不在消息里 —— 消息被虚拟列表卸载/重挂载都不会打断，也不会反复重播。
- 消息里同时给一张**白底淡蓝边的专属卡片**（`/player?file=…`，不自动播）作为重听入口。

### 服务与模型

- TTS 主服务 `18082`：Qwen3-TTS **0.6B-Base（克隆）**，1.7B VoiceDesign 只用来**设计一次音色**并落成 `assets/voice-me.wav`。
  - 新增 `/say-player`、`/stream-player?autoplay=1`、`/player?autoplay=1`（后者带 `合成中…` 状态与重试）。
  - `/warm` 可只加载模型不发声，供"回复前预热"。
- ASR 双档：`18083` Qwen3-ASR-**0.6B**（交互快道）+ `18080` Qwen3-ASR-**1.7B**（长音轨/视频）。
- 实测汇总见 `MODELS.md`。

### 工程

- 新增自诊断路由 `GET /voice-player/bubble-report`：客户端把气泡扫描结果（候选元素、是否解析、是否被守卫拦、整页命中数）回传宿主，排障不必开 devtools。
- 删掉死的 `/voice-player/post-disabled`（早期探索用 `subagents.sendMessage` 的错误路径）。
- 宿主系统提示新增一条三行规则：**用户发语音时必须先用 `voice_say` 回语音**，只打字时不适用。

### 已知限制

- 只在 Windows + RTX 5090 Laptop（24 GB）实测；其它显卡需自选 cu 轮子。
- `client.js` 仍留有早期渲染方案的遗留代码（旧 DOM 扫描、未使用的 `VoiceBubble`/`clickSendButton`），不影响运行，下个版本清理。
- CosyVoice2（`18081`）作为历史兜底保留，默认不启动。

## 0.1.0 - 2026-10-24

首个公开版本。

- 插件 `@local/dsh-voice-player`：`voice_say` 工具（按需拉起 TTS、失败回退 SAPI）+ 极简播放器视图。
- 技能 `speak`：发语音的固定流程（服务检查 → 预热 → 取文件名 → 透明容器播放器 → 文字复述 → 回读自检 → 回退表）。
- `tts/`：CosyVoice2-0.5B 常驻服务（`/say` 按文本缓存、`/player` 自绘播放器、`/last`、`/health` 带 `lastUsed`）。
- `asr/`：Qwen3-ASR-1.7B 服务（OpenAI 兼容转写、`/voice/*` 静态音频、SAPI `/tts` 兜底）。
- `scripts/`：`install.ps1`（两个 venv、torch cu128、源码、模型、参考音、config）、`download-models.py`（跳过 1.5 GB 无用文件）、`patch-cosyvoice.py`（torchaudio ≥2.9 的 load_wav 补丁）、`restart-guards.ps1`（可选）、`register-startup.ps1`（可选）、`verify.ps1`（端到端自检）。
- 文档：架构、硬件分级（24G/12G/8G/无独显）、模型逐文件清单、故障排查（症状→原因→处理）。

已知：只在 Windows 11 + RTX 5090 Laptop（24 GB）上验证过；非 50 系显卡需自行选 cu121 轮子。
