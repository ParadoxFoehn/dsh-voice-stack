> **2026-10-27 更新（流式）**：现在默认走流式播放，不要再用 `/player?file=…`。
> 播放器地址改为：`http://127.0.0.1:18082/stream-player?text=<URL 编码后的整句>`，
> 文本整段送进去（不要切句），音频由 `/say-stream` 边生成边播；没有整段缓存。
> `voice_say(text)` 只负责确保服务在线，不再预热合成——直接输出下面这种 iframe 即可。

---
name: speak
description: 用本机 Qwen3-TTS 发一条语音消息（流式播放，用户点开就能听），并把同一句话用文字复述在下面。**用户发来的是语音消息时必须用本技能回复**（单条 20 秒 / 约 120 字，超出部分写在文字里）；用户说"说句话 / 语音说 / 读给我听 / 用语音回答"时也用。含环境检查、服务拉起、流式播放器渲染、回读自检与失败回退。
whenToUse: ① 用户以语音消息的形式提问/聊天（此时必须语音回复，不能只回文字）；② 需要"我说给他听"时；③ 核实语音链路是否正常。纯文字提问不要用。
---

# speak —— 发一条语音消息（本机 TTS）

> 一句话：**调 `voice_say` 预热 → 查 `/last` 拿文件名 → 输出透明容器里的播放器 → 空一行写文字复述。**

## 0. 先看服务（两步，缺一个就重启守护）

```powershell
# TTS（CosyVoice2，18081）与 ASR（Qwen3-ASR，18080）
curl.exe -s http://127.0.0.1:18082/health   # 主：Qwen3-TTS
curl.exe -s http://127.0.0.1:18081/health   # 备：CosyVoice2
curl.exe -s http://127.0.0.1:18080/health
# 任一不 200 → 一键重启两个守护
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "D:\Harness工作区\dsh-tools\py-asr\restart-guards.ps1"
```

- 两个服务都是**懒加载**：`/health` 里 `ready:false` 表示模型还没进显存，第一次请求才加载（CosyVoice 冷启动约 16 s，热 1 s 内）。
- 都随 DSH 客户端起落（启动目录 `DSH-ASR-Guard.cmd` → `guard-asr.ps1` × 2）。
- TTS 端口 **18081**（`py-tts\tts_server.py`）；ASR **18080**（`py-asr\asr_server.py`）。

## 1. 确保服务在线（不再预热）：调工具

```
voice_say(text="要说的话")
```

- 该工具（插件 `@local/dsh-voice-player`）会请求 `18081/say?text=…`，把这一步的等待吃掉。
- 一句 **≤600 字**；不要一次发多条。

## 2. 拿文件名

```powershell
(Invoke-WebRequest "http://127.0.0.1:18082/last" -UseBasicParsing).Content   # {"text":"…","file":"say-xxxxxxxx.mp3"}
```

## 3. 输出播放器（**照抄这段结构**）

```html
<div id="vcp-root" style="background:transparent;padding:0;margin:0">
<style>
#vcp-root{padding:0;margin:0}
#vcp-root iframe{width:100%;height:44px;border:0;display:block;background:transparent}
</style>
<iframe src="http://127.0.0.1:18082/player?file=say-xxxxxxxx.mp3" title="语音"></iframe>
</div>
```

四条硬规则（都是一路踩出来的）：

1. **必须包 `#vcp-root`**：裸 `<iframe>` / 裸 HTML 会被消息层当纯文本显示成代码。
2. **容器透明、零内边距**：这就是"纯净播放器"——看起来是一条原生播放器，没有卡片边框和底色。
3. **不要用 `<audio>` 标签**：消息渲染层会过滤掉它（只剩空白）。
4. 播放器之后**空一行**再写文字，否则会和正文黏在一起。

## 4. 文字复述

播放器下面用一段文字把同一句写出来（不方便听的时候能看），然后正常回答问题。

## 5. 自检（可选但推荐）

```powershell
curl.exe -s -F "file=@D:\py-tts\out\<file>.mp3" http://127.0.0.1:18080/v1/audio/transcriptions
```

回读内容和原句一致 → 合成正常；回读是无关文字 → 先查是不是代码/模型版本错配（见 `py-tts\STATUS.md`）。

## 失败回退

| 症状 | 处理 |
| --- | --- |
| `18081` 不响应 | 跑 `restart-guards.ps1`；仍不行 → 用 SAPI：`http://127.0.0.1:18080/tts?text=…`，播放器改成 `http://127.0.0.1:18080/player?file=tts-<hash>.mp3` |
| 播放器显示 `0:00 / 0:00` | 音频源没连上：确认 `say-file` 能 200；再确认 iframe 里用的是 `18081/player` |
| 播放器显示成代码 | 忘了包 `#vcp-root` |
| 声音出来但内容不对 | CosyVoice 版本错配（main≠v2.0）；见 `py-tts\STATUS.md` |
| 每轮都自动冒出一条语音 | 插件里不要再挂 `turnTail` 自动播放器（2026-10-24 已移除） |

## 相关

- 插件：`D:\Harness工作区\dsh-plugins\voice-player\`（`voice_say` 工具 + 极简播放器视图）
- TTS 服务：`D:\Harness工作区\dsh-tools\py-tts\`（`tts_server.py` / `tts-server.cmd` / `say.py` / `STATUS.md`）
- ASR 服务：`D:\Harness工作区\dsh-tools\py-asr\`（`asr_server.py` / `asr-server.cmd` / `README.md`）
- 语音输入插件（转文字，**已禁用**，仅作参考）：`@goodandready/dsh-voice`
---

## 语音对话的强制规则（2026-10-27 用户定）

**用户用语音说话时，必须用语音回复。** 不是"可以"，是"必须"——这是这条规则的全部要点。

### 时长上限

- 一条语音控制在 **20 秒左右**（中文约 **90–120 字**；我们实测约 4–5 字/秒）。
- 只把**最要紧的话**放进语音；细节、列表、代码、数据表放在语音下面的文字里。
- 语音里不要念数字表格、不要念路径、不要念 Markdown——那些用文字。

### 超长怎么办

- 内容确实说不完：语音里先说结论（一句话），再用文字展开，并在文字里**说明"这段没说完的部分在下面"**。
- 用户想听更长的：**主动提醒他可以调**（改 `SKILL.md` 里的字数上限，或直接说"展开讲讲"我就分条发多条语音）。默认值不要悄悄改。

### 说话方式

- 口语，不是朗读稿：短句、少术语、不要"首先其次最后"。
- 不念"括号里的补充"、不念表情、不念链接。
- 语音之后**空一行**，再写文字（这条是渲染要求，不是风格要求）。

### 为什么定 20 秒

流式输出只是把"第一声"提前到几百毫秒，**总时长仍等于模型生成时间**；一条 40 秒的语音要生成近 20 秒，用户等的是"说完之后还要等"，收益不大。20 秒 ≈ 一次自然表达的长度，再长就该分条或用文字。

---

## 安装/升级前的硬检查（对小肥鱼）

在替主人安装或升级这套语音栈之前，**先跑** `scripts/preflight.ps1`（PowerShell，退出码 0 才继续）：

- 退出码 **1** + `PREFLIGHT: BLOCKED old-v01` → 机器上还有 v0.1。**必须停下来告诉主人**要删掉旧版：
  读 `scripts/messages.json` 里的 `old-v01.message_zh`，原话转达（含那三步：关客户端、删旧目录、卸载旧插件）。
  **不要**绕过、不要替主人决定“先装上再说”。
- 退出码 **0** → 继续安装。
- 细节永远在 `scripts/preflight.json` 的 `findings` 里（哪一项触发了：VERSION / 旧模型树 / 已装插件 / 18081 还在跑）。
