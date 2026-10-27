# 架构（v0.2.0）

> 一句话：**语音走消息流，不走输入框**。用户的话和助手的话都变成会话里的消息，音频用原生的 `<audio>` 播放；插件只负责"录制 / 合成 / 投递 / 播一次"四件事。

## 1. 组成

```
┌───────────────────────────── DSH 客户端（Electron 渲染进程）─────────────────────────────┐
│  plugin/client.js  (@local/dsh-voice-player · web 半边)                                  │
│    ├─ 声波按钮（conversation.input.left, order 6） → 录音 → 待发托盘 → 发送                │
│    ├─ 标记 → 气泡渲染（把 `【语音 N.Ns】url` 换成原生 <audio> 白卡）                        │
│    └─ 一次性播放器（轮询 /last-voice → 挂 <audio> → 播一次 → 撕掉 → 写记号）               │
└───────────────────────────────────────┬────────────────────────────────────────────────┘
                                        │ HTTP（全部 127.0.0.1）
┌───────────────────────────────────────┴────────────────────────────────────────────────┐
│  plugin/index.js（host 半边 · 跑在宿主进程）                                             │
│    ├─ 工具 voice_say(text)          → 确保 TTS 在跑 → /say 整段合成 → 记录 lastVoice      │
│    ├─ 路由 GET /voice-player/ensure        → 探活/拉起 TTS（WMI 脱离进程，无控制台）       │
│    ├─ 路由 GET /voice-player/probe-send    → sessionController.prompt()（用户语音投递）    │
│    ├─ 路由 GET /voice-player/last-voice    → 客户端轮询"刚合成的是哪个文件"                │
│    ├─ 路由 GET /voice-player/bubble-report → 客户端回传气泡扫描结果（自诊断）              │
│    └─ systemPrompt.section                 → 三行规则：用户发语音 → 必须语音回复            │
└───────────────────────────────────────┬────────────────────────────────────────────────┘
                                        │
        ┌───────────────────────────────┼───────────────────────────────┐
        │                               │                               │
┌───────┴────────┐              ┌───────┴────────┐              ┌───────┴────────┐
│ 18082 TTS      │              │ 18083 ASR 快道 │              │ 18080 ASR 长音 │
│ Qwen3-TTS      │              │ Qwen3-ASR-0.6B │              │ Qwen3-ASR-1.7B │
│ 0.6B 克隆为主  │              │ 交互短句       │              │ 视频/长音频    │
│ 1.7B 设计音色  │              │ 默认档         │              │ 默认不启动     │
└────────────────┘              └────────────────┘              └────────────────┘
```

端口与进程都独立于插件：**插件只发 HTTP，不自己加载模型**，所以模型挂了插件不会挂。

## 2. 两条主流程

### 2.1 用户说 → 助手听（voice input）

```
点声波 → GET /health（18082）
        ↘ 没起 → GET /voice-player/ensure（WMI 拉起，等最多 ~30 s）
录音（MediaRecorder · audio/webm;codecs=opus，30 s 硬上限）
   → POST /upload?ext=webm&transcribe=0（原始字节）
   → 服务端 ffmpeg 转 16k 单声道 mp3，落 out/in-<hash>.mp3
   → 返回 {url:"/say-file/in-….mp3", seconds: 12.3}
   → 客户端生成标记并放入托盘（最多 3 条，可试听/撤回）
点「发送 N 条」→ 标记拼接 → GET /voice-player/probe-send?text=…
   → 宿主：sessionController.prompt({ sessionId, requestId, content:[text], mode:'followup' })
   → createUserMessage({ content, source:{kind:'user'} }) → agent.followup(message)
   → 会话里出现一条用户消息（**不经过输入框，不合成按键**）
渲染：气泡扫描器把"整段只有标记"的元素换成白卡 + 原生 <audio>（一条消息 N 个标记 → N 个气泡）
助手读到标记 → 转写（18083）→ 决定回复
```

### 2.2 助手说 → 用户听（voice output）

```
助手调用 voice_say(text)
   → 宿主 ensureTts()（探活/拉起）
   → GET /say?text=…（整段合成，按 sha1(模式+音色+文本) 缓存到 out/qwen-<digest>.mp3）
   → GET /last → { file:"qwen-….mp3", sec: 9.0 }
   → 宿主记住 lastVoice = { file, secs, at }

客户端（每 1.2 s）→ GET /voice-player/last-voice
   → 文件在 localStorage['dsh-voice-played'] 里？在 → 跳过
   → 不在 → 在 body 上挂一个不可见 <audio>，自动播放**一次**
   → ended：写记号 + 立刻移除元素
   → error：只移除，**不写记号**（下次还会响）

助手消息正文另外给一张白底淡蓝边卡片（/player?file=…，不自动播）= 重听入口
```

## 3. 关键设计决策（都有代价，写清为什么）

| 决策 | 原因 | 代价 |
| --- | --- | --- |
| 用户语音走 `sessionController.prompt` | 这是官方"用户发消息"入口，与定时提醒同一扇门；消息是真正的 user 消息，历史/重放/搜索都正常 | 需要宿主有 `sessionController`（DSH 0.2.1+ 默认有） |
| 助手语音**整段合成 mp3** 而非流式 WAV | WAV 流式头里长度是 `FFFFFFFF`，浏览器没有终点，会**播到一半停住**（实测） | 首声延迟 ≈ 时长 × 0.38（7.9 s 音频约 2.5 s，热态） |
| 一次性播放器放在**插件层**而不是消息里 | 消息列表虚拟化：滚出视口就卸载，消息里的 `<audio>`/iframe 会重载、从头播 | 播放不跟随消息滚动（这也正是想要的行为） |
| 判据用「播完记号」而不是时间窗 | 时间不知道用户听没听；被打断/切走都算没听完 | 需要持久化（localStorage），且只保留最近 200 条 |
| 气泡渲染**不改 `conversation.chat.node`** | 接管渲染器会连普通消息一起改，历史上把按钮和草稿一起卸掉过 | 只能在 DOM 上"替换整段只有标记的元素"，限制形态 |

## 4. 端点清单（自测用）

| 端点 | 方法 | 用途 |
| --- | --- | --- |
| `/health` | GET | `{base_ready, design_ready, lastUsed, voice}` |
| `/warm` | GET | 只加载模型不发声（回复前预热） |
| `/voice` | GET/POST | 读/写音色（`mode/instruct/ref/ref_text`） |
| `/say?text=` | GET | 整段合成 mp3（缓存） |
| `/say-stream?text=` | GET | 流式 WAV（**不要用于播放**，见上） |
| `/say-player?text=&autoplay=` | GET | 整段合成的播放页（带 `合成中…` 状态） |
| `/player?file=&autoplay=` | GET | 播放**已存在**文件（重听入口） |
| `/say-file/<name>` | GET | 音频实体（`audio/mpeg`） |
| `/last` | GET | 最近一次合成的 `{text,file,sec,wall}` |
| `/upload` | POST | 原始音频字节 → mp3（可选转写） |
| `/voice-player/ensure` | GET | 拉起 TTS |
| `/voice-player/probe-send?text=&sessionId=` | GET | 投递一条用户消息（`?probe=list` 可列会话） |
| `/voice-player/last-voice` | GET | 客户端轮询用 |
| `/voice-player/bubble-report` | GET/POST | 自诊断（客户端上报，运维读取） |

## 5. 文件地图

```
tts/qwen_tts_server.py       TTS 主服务（0.6B 克隆 + 1.7B 设计 + 播放页 + 上传）
asr/asr_server.py            ASR 服务（OpenAI 兼容 /v1/audio/transcriptions；18080/18083 同代码不同模型）
plugin/index.js              宿主半边（工具 + 5 个路由 + 三行系统提示）
plugin/client.js             web 半边（按钮 / 托盘 / 气泡 / 一次性播放器）
scripts/install.ps1          装两个 venv、torch cu128、模型、参考音
scripts/verify.ps1           端到端自检（TTS / ASR / 播放页 / 端口）
```

## 6. 排障顺序

1. `GET /health` 看 `base_ready`；false 说明模型没加载（`/warm` 一次）。
2. 听不到 → 看 `GET /voice-player/last-voice` 是否有 file；有 file 但没响 → 多半是自动播放策略（卡片仍可点）。
3. 气泡不出来 → `GET /voice-player/bubble-report` 读 `count / diag / bodyHits`：
   - `bodyHits = 0` → 标记根本没进 DOM；
   - `bodyHits > 0` 但 `count = 0` → 候选被守卫拦（看 `diag[].guard` / `at` / `len`）。
4. 用户语音发不出去 → `GET /voice-player/probe-send?probe=list` 确认会话可解析。

## 7. 已知限制

- 只在 Windows + RTX 5090 Laptop（24 GB）验证；12 GB 以下需换更小模型或走 CPU。
- `client.js` 留有 0.1/试探期的遗留代码（旧 DOM 扫描、未用的 `VoiceBubble`/`clickSendButton`），不影响运行。
- 单条录音上限 30 s（`MAX_SECONDS`）；0.6B ASR 的音频位置上限 `max_source_positions=1500`，折算约 60 s 是硬边界。
