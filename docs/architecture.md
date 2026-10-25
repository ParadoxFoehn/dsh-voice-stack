# 架构：一条语音在机器里怎么走

```
                               ┌──────────────────────────────┐
  DSH 客户端（对话界面）        │  plugin/   @local/dsh-voice-player
  ┌───────────────────┐        │  ├─ index.js  (host)  voice_say 工具
  │ #vcp-root iframe   │◄───────┼──┤   └─ 预热请求 18081/say
  │ 18081/player?file= │        │  └─ client.js (web)  播放器视图
  └───────────────────┘        └──────────────────────────────┘
            ▲                                   │
            │ ② GET /last 取文件名               │ ① 预热
            │                                   ▼
  ┌─────────┴──────────────┐        ┌──────────────────────────┐
  │ asr 服务  127.0.0.1:18080│        │ tts 服务  127.0.0.1:18081 │
  │ • /v1/audio/transcriptions│◄─────┤ • /say?text=  合成 mp3    │
  │ • /voice/<file>  静态音频 │  镜   │ • /player?file= 播放页    │
  │ • /player?file=  播放页   │  像   │ • /last         最近一句   │
  │ • /health                 │  文   │ • /health                 │
  └─────────┬──────────────┘  件   └────────────┬─────────────┘
            │                                    │
            ▼                                    ▼
   models/Qwen3-ASR-1.7B              models/CosyVoice2-0.5B
   （4.4 GB，懒加载，~6.5 GB 显存）    （3.9 GB 必需文件，懒加载，~3 GB 显存）
```

## 三个进程，两条链路

### 发语音（我 → 你）

1. agent 调 `voice_say(text)`；
2. 插件宿主侧向 `18081/say?text=…` 发请求（把模型加载与合成的等待吃掉）；
3. 服务端按文本 hash 缓存 mp3（`tts/out/say-<hash>.mp3`），并把副本镜像到
   `shared_voice/`（配置项 `voice_share_dir`），因为 ASR 服务负责静态文件对外供给；
4. agent 取 `18081/last` 拿到文件名；
5. 在消息里输出一个**透明容器 + iframe**：
   `<div id="vcp-root">…<iframe src="http://127.0.0.1:18081/player?file=…">`；
6. 播放页是一个只有 `<audio controls preload="metadata">` 的极简 HTML —— 控件可见、不自动播。

### 收语音（你 → 我，可选）

插件或任何兼容客户端把音频 POST 到 `18080/v1/audio/transcriptions`（OpenAI 兼容格式），
服务端把任意格式音频用 ffmpeg 转成 16 kHz 单声道后交给 Qwen3-ASR。

## 为什么要两个服务而不是一个

- 两套模型依赖的 numpy / transformers 版本**互斥**（见 HARDWARE.md），必须两个 venv；
- 两个进程各自懒加载，互不拖累；显存按需占用，空闲时几乎为 0；
- 静态音频与播放页挂在 ASR 服务上（它是先写的那个），省一个端口。

## 启动策略（2026-10-24 调整）和服务管理

语音服务**不再随开机/客户端自启**：`scripts/restart-guards.ps1` 与 `asr/guard-asr.ps1` 保留为可选工具（手动排障时用），默认不注册开机项。
启动方式改为按需：

- agent 调 `voice_say` 时，插件先探测 `18081/health`，不在就**脱离控制台拉起** TTS，然后合成；
- 或用本地模型悬浮窗（`@local/local-models-monitor`）里语音条目的「启动 / 关闭」按钮；
- 语音模型属**低优先级**：闲置（默认 30 秒无请求）且整机显存高于 16 GB 时自动关闭，给其它模型让路。

## 守护（可选工具）：随客户端起落

`asr/guard-asr.ps1` 是一个通用守护（`-Port/-Server/-LogName`），行为：

```
客户端进程存在 → 端口没监听就拉起（WMI 脱离控制台，避免黑窗）
客户端进程消失 → 结束该端口进程，释放显存
```

`scripts/restart-guards.ps1` 用同一份守护脚本起两份实例（18080 / 18081）。

## 数据与缓存

| 位置 | 内容 | 可否删除 |
| --- | --- | --- |
| `tts/out/` | 合成结果（按文本 hash 缓存） | 可，删了会重新合成 |
| `shared_voice/` | 供 ASR 服务静态分发的副本 | 可 |
| `logs/` | 服务输出与守护日志 | 可 |
| `models/` | 模型权重 | 不要随意删，重下要 8.8 GB |

## 设计取舍（为什么是现在这样）

| 选择 | 原因 |
| --- | --- |
| iframe 播放器，而不是 `<audio>` 标签 | 消息渲染层会过滤 `<audio>`；裸 iframe 又会被当纯文本，必须包 `#vcp-root` |
| 播放页由服务端出，而不是插件组件 | 工具调用卡在界面上默认折叠，播放器放进去用户看不到 |
| 透明容器（`background:transparent;padding:0`） | 满足"纯净播放器、不要卡片样式"的要求 |
| 文本 hash 命名 | 同一句话重复发不重复合成，第二次是毫秒级 |
| 所有子进程 `CREATE_NO_WINDOW` | 否则每次合成都会闪一个黑色控制台窗口 |
