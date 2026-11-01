# CHANGELOG

## 0.3.0 - 2026-10-30

### 1. 显存占用大幅下降（这一版最直观的变化）

- **TTS 默认改走 CPU**：实测与 GPU 同速（36 字：CPU 2.50 s / GPU 2.55 s，**0.98×**），
  原因是 TTS 自回归逐字生成、`batch=1` 时受串行延迟限制，显卡并行度用不上。
  TTS 一栏从此**不占显存**，只吃约 2.6 G 内存。
- **ASR 默认模型 1.7B → 0.6B**：显存 **4.7 G → 2.3 G**；60 秒清洗音频上与 1.7B **逐字相同**、速度还快 5%。
  1.7B 只在会议录音转写、看视频、噪声/方言/术语密集的音频里显式启用。
- **空闲自动卸载**：ASR 默认空闲 120 秒卸掉模型；8 G 及以下显卡也能跑完整语音栈。
- **合计**：默认档常驻显存约 **2.3 G**（原约 4.6 G），含本地大模型的整机占用从约 10 G 降到约 5 G。

### 2. 语音服务改由插件托管（修复"关不掉、显存不还"）

- 服务改由插件 `spawn`，**插件停用/卸载时连进程树一起杀掉**，不再残留显存。
- 新增父进程看门狗 **`--parent-pid`**：插件崩溃后服务自行退出（5 s 轮询，实测端口 9 s 内释放）。
- **删除旧的 WMI 启动方式**（`Win32_Process.Create`）——那是"服务能活过插件、显存占着不还"的根源。
- 新增 **`--idle-unload <秒>`**（ASR / TTS 均支持）。

### 3. 新增：语音按钮的开关与设置面板

- **按钮三态**：服务未启动 → 灰色（单击即启动）；启动中 → 禁用防连点；就绪 → 正常录音。
- **右键菜单**：开启/关闭语音服务、设置…。
- **设置面板**：TTS 两栏（常驻 / 空闲卸载＋秒数；GPU / CPU）+ ASR 一栏（常驻 / 空闲卸载），
  底部实时显示预计占用与建议。
- 新增端点：`GET /voice-player/status`、`POST /voice-player/service`、`GET|POST /voice-player/settings`。
- 新增 `config.json`：`asr.mode / asr.idleSec`、`tts.mode / tts.idleSec / tts.device`。

### 4. 修复

- **右键菜单跑偏**：原先固定在屏幕右下角，现在跟随按钮坐标弹出。
- **设置面板点不开**：宿主端点尚未就绪时配置为空导致不渲染，已加默认值兜底。
- **颜色不跟随客户端明暗**：菜单 / 面板 / 待发托盘 / 语音气泡卡统一改走主题令牌 + 祖先背景亮度判定，
  白皮肤白底黑字、黑皮肤黑底白字（原先透明 `body` 被误判成黑色）。

### 升级注意

- 首次启动自动生成 `config.json`（默认值即上文）。
- **改档位后需"关→开服务"才生效**；本版改动**需要重启客户端**。

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
- 清理 `client.js` 里 0.1 时期的死代码（843 → 598 行）：旧 DOM 扫描器、未用的 `VoiceBubble`、`clickSendButton`、`sendViaActions`，以及指向已退役 18081 的 `VoiceMessage` 播放器。

### 已知限制

- 只在 Windows + RTX 5090 Laptop（24 GB）实测；其它显卡需自选 cu 轮子。
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
