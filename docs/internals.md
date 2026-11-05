# 技术说明 · 实现原理与排障

> 给**排查问题的人**看：这套东西为什么这么设计、坏的时候先看哪。
> 使用流程本身在 [`plugin/使用说明.md`](../plugin/使用说明.md)，安装步骤在 [`INSTALL.md`](../INSTALL.md)。
> 版本 v0.6.0 · 2026-11-05

## 1. 一页链路

```
用户说话 → 客户端麦克风 → ASR(18080) → 写 voice-inbox.jsonl ──┐
                                                              ├→ agent 读文本 → voice_say(text)
agent 说话 → 宿主 index.js 分组建表 → TTS(18082) → mp3 落盘 ┘        │
                │                                                     │
                ├─ 第一组立刻返回 ──┐                                 │
                └─ 其余组后台合成 ──┴→ 客户端轮询 last-voice → 队列 → 播一组 → ended → next-group
```

**一句话分工**：插件只发 HTTP、不管模型；客户端只负责"播没播过"；模型进程挂了插件不会挂。

## 2. 五个必须知道的机制

### 2.1 分组合成：为什么要拆，拆了怎么接上

`splitGroups()` 按句号/分号切句、**每 2 句一组**。`voice_say` 只等第一组合成完就返回，
其余组在后台继续合成；客户端播完一组，向 `/voice-player/next-group?voice=<id>` 要下一组，
没合成好就回 `pending`，客户端 400 ms 后重试。

- **为什么拆**：整篇合成完再播，长文要干等几十秒才出声。
- **为什么带 `voice`**：agent 连发多条时，`lastVoice` 会被后一条顶掉。不带 id 就分不清
  "这条剩下的组"和"那条的组"。宿主用 `recentVoices`（id → 分组表，留最近 10 条）保证每条都能取完。
- **坏了看哪**：只播第一组 → 查 `plugin/index.js` 里 `recentVoices` 是否还在、`next-group` 是否还按 id 取；
  两句之间停顿 → 查 TTS 是否被单实例串行锁卡住（`gpu2` 两实例可并行）。

### 2.2 播放器为什么在插件层、不在消息里

消息列表是**虚拟化**的：滚出视口就卸载重挂。放在消息里的 `<audio>` 会重载、从头播。

- 插件层挂一个游离 `<audio>`，播完写 `localStorage['dsh-voice-played']` 记号再撕掉；
- 判据是**"播完才算听过"**，不是时间窗——加载失败不写记号，宁可下次再响；
- 打断时把片段写进 `suppressed`（内存集合，留 60 条），轮询跳过它。

**坏了看哪**：打断后又从头念 → 是否还在 `currentTime = 0`（倒带等于重播）；同一句反复播 → `played` 记号是否写进 localStorage。

### 2.3 音频必须走同源代理

气泡里的播放地址是 `/voice-player/audio?file=…`（宿主转发到 18082 的 `/say-file/`）。
**直连 `127.0.0.1:18082` 会被页面 CSP 拦**，表现是"点了没反应、随后变灰"。

### 2.4 半双工、心跳与断句（通话）

- **半双工**：我播报时麦克风是关的。用户这时说的话会丢或排队——这是设计，不是 bug。
  用户要插话只能点悬浮条「打断」。
- **断句**：最后一个字之后静音 `call.silenceMs`（默认 2000 ms）才算说完。太小会抢话，
  太大会被嫌慢；一句话被拆成两条（用户重复说同一件事）通常就是这里偏小。
- **三态灯**：`聆听` = 麦克风在采集 **且** agent 正卡在 `voice_wait`（心跳 400 ms 一次）；
  `忙线` = 其余全部（在想、在合成、在播报、在转写）；`准备中` = 接通后前 3 秒。
  只按麦克风算会把"它正忙、你说白说"亮成聆听。

### 2.5 服务生命周期

- 服务由插件 `spawn` 并托管，插件停用/卸载时连进程树一起杀（避免"服务活着、显存占着不还"）；
- `--parent-pid` 看门狗：插件崩溃后服务 5 s 内自行退出；
- `--idle-unload <秒>`：空闲只**卸模型不杀进程**，下次秒回；
- 端口：TTS 18082（`gpu2` 档加 18083 第二个实例）、ASR 18080 / 18083 快道。

## 3. 时间线与文件

每通电话按会话隔离在 `…\输出\calls\<sessionId>\`：

| 文件 | 内容 |
| --- | --- |
| `voice-inbox.jsonl` | 每行 `{"t","type":"start"|"speech"|"end","text","callId","sessionId"}` |
| `voice-inbox.read` | 已读到第几行（`voice_wait` / `voice_call_status` 自动维护，别手写） |
| `voice-heartbeat.txt` | agent 心跳时间戳，客户端据此判断"它还在等你说" |

**只认本通的 `end`**：`inbox` 里躺着历次通话的 end，只有"最后一条 start 之后"的才算数。

## 4. 排障索引

| 症状 | 先看 | 常见真因 |
| --- | --- | --- |
| 有标记但没有播放器 | `<GUI>/voice-player/bubble-report?all=1` 的 `count`，控制台 `window.__voiceDebug()` | 标记被正文包住 / 加了代码块 / 一条塞了两个标记 |
| 点了播放没反应、随后变灰 | 播放地址 | 直连 18082 被 CSP 拦，改走 `/voice-player/audio` |
| 只念前半句 | `next-group` 是否按 id 取组 | `recentVoices` 缺失（v0.6.0 前的 bug） |
| 打断后又从头念 | `suppressed` 是否写入、`currentTime` 是否被清零 | 同上 |
| 判成"已挂断"但还在通话 | `voice_call_status` 的 `inCall`/`callId` | 读到了上一通的 `end`，或自己数行数判断 |
| 用户说话被吞 | 播报时长 | 半双工：单条 >30 s 时麦克风关得太久 |
| 同一句话被当成两句 | `call.silenceMs` | 断句阈值偏小 |
| `voice_say` 报 `18082 -> 500` | `D:\py-tts` 的服务日志 | 同一 TTS 实例被并发打崩（CUDA device assert），只能重启 |
| 面板跑到屏幕下方 | 面板挂的插槽 | 挂在 `conversation.input.left`（带 transform 的祖先），必须挂 `shell.overlay` |
| 服务启动就退出 | `--parent-pid` | 宿主已退出，看门狗按设计自杀，属正常 |

## 5. 真实踩过的坑（案例）

来自《流式语音输入可行性》会话的通话记录（`输出\voice-inbox.jsonl`，2026-11-04）：

1. **"喂，好了吗？""喂喂喂！测试测试。"连喊三遍** —— 长播报期间麦克风全关，用户的话被丢掉。
   正解不是加长超时，而是**拆段 + 连轴合成**，把单段播报压到 30 秒内。
2. **同一句"再背一首李白的诗"在 inbox 里出现两条** —— 断句阈值偏小，把一句话切成了两次 speech。
   出现"同一请求执行两遍"时先怀疑 `call.silenceMs`，不是 agent 发疯。
3. **用户要求"播上一条的时候就开始准备下一条的合成"** —— 这就是渐进式分组合成的来源。
   现在 `voice_say` 返回第一组即出声，其余组后台备好。
4. **老格式的 `end` 没有 `callId`** —— 早期通话记录里 end 与 start 无法配对，导致"电话早挂了还在念"。
   现在每条 start/end 都带 `callId` + `sessionId`，判定只看最后一通。

## 6. 改动这一层时的红线

- **同一 TTS 实例不许并发**：会触发 `CUDA error: device-side assert`，整进程报废。
- **不要退回"整篇合成完再播"**（干等）或"播完一组才合成下一组"（空等）。
- **不要把浮层挂在输入框槽位**：那里有 `transform`，`position:fixed` 会错位。
- **浮层不要落在窗口拖拽带里**：Windows 顶端 `--dsh-windows-titlebar-height` 高度内是
  `-webkit-app-region: drag` 的窗口拖拽区，Electron 会把鼠标事件整个抢走——表现是**既点不了也拖不动**。
  浮层要么按该高度往下让位（`top: calc(var(--dsh-windows-titlebar-height,64px) + 12px)`），
  要么自己声明 `-webkit-app-region: no-drag`（2026-11-05 实测踩到）。
- **不要让 agent 自己数 `voice-inbox.jsonl` 的行**：一律用 `voice_call_status` / `voice_wait`。

## 7. 日志怎么看（排查第一步）

### 三个位置

| 日志 | 路径 | 看什么 |
| --- | --- | --- |
| **通话对话** | `…\输出\calls\<sessionId>\voice-inbox.jsonl` | 每行一问一答：`start` / `speech` / `end`，带 `callId` |
| 已读位置 / 心跳 | 同目录 `voice-inbox.read`、`voice-heartbeat.txt` | 读到第几行；agent 最后一次等待心跳的时刻 |
| **服务日志** | `D:\py-tts\logs\` 下 `<service>-service.log`（tts / asr） | 启动、模型加载、CUDA 报错、合成耗时 |

> 早期版本所有会话共用一个 `…\输出\voice-inbox.jsonl`（不分 sessionId），现在按会话隔离，旧文件只作历史参考。

### 三条读法

```powershell
# 1) 最近 10 行：看用户最后说了什么、这一通有没有正常收尾
Get-Content "...\输出\calls\<sessionId>\voice-inbox.jsonl" -Tail 10

# 2) 这一通是从哪开始的：找最后一条 start 的行号，往后才算本通
Select-String -Path "...\voice-inbox.jsonl" -Pattern '"type":"start"' | Select-Object -Last 1

# 3) agent 还在不在等：心跳文件 3 秒内更新过 = 正在等你说；停了 = 忙线或已收工
(Get-Date) - (Get-Item "...\voice-heartbeat.txt").LastWriteTime
```

**判读口诀**

- `end` 之后又出现 `speech`，又没有新的 `start` → 客户端状态和文件不同步，先看客户端是否重启过；
- 一条请求在 `speech` 里出现两次 → 断句阈值偏小（`call.silenceMs`），不是 agent 重复执行；
- 用户说话时间点落在我播报的时间里 → 半双工吞话，属于设计行为；
- `voice_say` 失败时先看 `D:\py-tts\logs\tts-service.log` 末尾，`CUDA error` 表示实例被打崩，只能重启。
