---
name: speak
description: 用本机 CosyVoice2 发一条语音消息（对方点开就能听），并在下面用文字复述同一句。用户说"说句话 / 用语音回答 / 读给我听"时使用；也是"我需要开口说话"时的固定流程。含服务检查、合成、取文件、透明播放器渲染、回读自检与失败回退。
whenToUse: 需要"我说给他听"（发语音消息）时；或需要核实语音链路是否正常时。纯文字回答不要用。
---

# speak —— 发一条语音消息（本机 TTS）

> 一句话：**调 `voice_say` 预热 → 查 `/last` 拿文件名 → 输出透明容器里的播放器 → 空一行写文字复述。**

端口默认 ASR `18080`、TTS `18081`（以 `config/config.json` 的 `ports` 为准）。

## 0. 先看服务

```powershell
curl.exe -s http://127.0.0.1:18080/health
curl.exe -s http://127.0.0.1:18081/health
# 任一不是 200 → 一键重启两个守护
powershell -NoProfile -ExecutionPolicy Bypass -File <repo>\scripts\restart-guards.ps1
```

- 两个服务都是**懒加载**：`/health` 里 `ready:false` 表示模型还没进显存，第一次请求才加载（CosyVoice 冷启动 10–20 秒，热 1–3 秒）。
- 若模型加载报显存不足，先看 `nvidia-smi` 是不是别的应用（ComfyUI 等）占着显存。

## 1. 预热合成

调用工具：

```
voice_say(text="要说的话")
```

- 工具由插件 `@local/dsh-voice-player` 提供，会请求 `18081/say?text=…`，把等待吃掉。
- 一句 **≤600 字**；一条消息只发一条语音。

## 2. 拿文件名

```powershell
(Invoke-WebRequest "http://127.0.0.1:18081/last" -UseBasicParsing).Content   # {"text":"…","file":"say-xxxxxxxx.mp3"}
```

## 3. 输出播放器（照抄这段结构）

```html
<div id="vcp-root" style="background:transparent;padding:0;margin:0">
<style>
#vcp-root{padding:0;margin:0}
#vcp-root iframe{width:100%;height:44px;border:0;display:block;background:transparent}
</style>
<iframe src="http://127.0.0.1:18081/player?file=say-xxxxxxxx.mp3" title="语音"></iframe>
</div>
```

四条硬规则（都是一路踩出来的）：

1. **必须包 `#vcp-root`**：裸 `<iframe>` / 裸 HTML 会被消息层当纯文本显示成代码。
2. **容器透明、零内边距**：这才是"纯净播放器"，看起来是一条原生播放器，没有卡片边框和底色。
3. **不要用 `<audio>` 标签**：消息渲染层会过滤它（只剩空白）。
4. 播放器之后**空一行**再写文字，否则会和正文黏在一起。

## 4. 文字复述

播放器下面用一段文字把同一句写出来（不方便听的时候能看），然后正常回答。

## 5. 自检（推荐）

```powershell
curl.exe -s -F "file=@<repo>\tts\out\<file>" http://127.0.0.1:18080/v1/audio/transcriptions
```

回读内容和原句一致 → 正常；是无关文字 → 见下表的"内容不对"。

## 失败回退

| 症状 | 处理 |
| --- | --- |
| `18081` 不响应 | 跑 `scripts\restart-guards.ps1`；仍不行 → 用 SAPI 兜底：`http://127.0.0.1:18080/tts?text=…`，播放器改成 `http://127.0.0.1:18080/player?file=tts-<hash>.mp3` |
| 播放器显示 `0:00 / 0:00` | 音频源没连上：确认 `say-file` 能 200；再用 `18081/player?file=…` |
| 播放器显示成代码 | 忘了包 `#vcp-root` |
| 声音出来但内容不对 | CosyVoice 代码版本错配（必须 tag `v2.0`，不是 `main`） |
| 每轮都自动冒出一条语音 | 插件里不要挂 `turnTail` 自动播放器 |
| `CUDA out of memory` | 别的应用占着显存，先释放（ComfyUI：`POST /free`） |

## 相关文件

- 插件：`plugin/`（工具 `voice_say` + 极简播放器视图）
- TTS 服务：`tts/tts_server.py`（常驻）、`tts/say.py`（一次性 CLI）
- ASR 服务：`asr/asr_server.py`（转写 + `/voice/*` + `/player`）
- 路径与端口：`config/config.json`
