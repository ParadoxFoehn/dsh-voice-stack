# voice-player 注释（2026-11-04 第五次整理，v0.5.17）

- 状态：**active，保留**；本机语音输出主路径。
- 链路：`voice_say` → 18082 Qwen3-TTS（GPU）→ mp3 落 `D:\py-tts\out` → 宿主同源代理 `/voice-player/audio` → 气泡里 `<audio>` 播放。
- 档位与策略（`ttsPlan()`，index.js）：
  - `gpu` 单实例 **串行**（默认）；
  - `gpu2` 同一模型两个实例并行（音色一致）；
  - `mix` Qwen3(GPU) + CosyVoice2(CPU) 并行（**音色不同**，会出现接缝）；
  - `cpu` CosyVoice2 单实例。
- **文件按会话隔离**：`…\输出\calls\<sessionId>\` 下三个文件（`voice-inbox.jsonl` / `voice-inbox.read` / `voice-heartbeat.txt`）。以前所有会话共用一个 inbox，上一通的 `end` 会串进下一通；目录名做过净化，取不到 sessionId 时落 `calls\default\`。
- 通话链路：
  - 接通 → 写 `{"type":"start","callId":…}`（带 `sessionId`）+ 注入「（语音通话已开始）」+ POST `/voice-call/state`；
  - 说话 → 本会话 `voice-inbox.jsonl` 追加 `speech` 行；
  - agent 侧 → `voice_say` 出声、`voice_wait` 阻塞等新句、`voice_call_status` 查状态（顺带刷心跳，客户端据此亮「聆听」）；
  - 挂断 → 写 `end`（带同一 `callId`）+ POST 状态 + `session.cancel()`。
- **只认本通的 end**：`callWindow()` 以「最后一条 start 之后」为界判定；旧格式（无 start）退回只信客户端 `active`。
- **已读行号自动维护**：`voice_call_status` / `voice_wait` 每次调用都把行数写回本会话的 `voice-inbox.read`，不再依赖 agent 手写（曾滞后 14 行）。
- **断句**：`call.silenceMs` 默认 **2000ms**（可调 600–3500）；太短会抢话，太长会被嫌慢。
- **长播报吞话**：半双工下播报期间麦克风关闭，用户的话会被丢或排队。约定单次 ≤120 字（≈30 秒），更长的拆 2–3 次、中间插 `voice_wait`；`voice_say` 超过 30 秒会返回 `warn`。
- **长回复是流水线**：只等第一组合成完就返回、立刻开播，其余组在播放期间后台合成，客户端 `ended` 时来 `/voice-player/next-group` 取（未就绪返回 `pending`，400ms 重试）。别退回「整篇合成完再播」（干等）或「播完一组才合成下一组」（空等）。
- **多条语音排队播放**：`/voice-player/last-voice` 带回 `history`（最近 12 条正序），客户端按顺序播放；每条带 `voice id`，取后续分组时带上（`next-group?voice=…`），agent 中途再发一条时老链只会拿到 `done`；打断按钮清空整个队列。别再退回「新语音直接盖掉正在播的那条」（2026-11-04 实测过：前一条没播完就开始放新的）。
- TTS 侧两条硬约束：
  1. **长句必须先切**——服务端 `split_for_tts()` 按标点切到 ≤20 字，逐句生成再拼接；
  2. **同一个实例不可并发**——并发会触发 `CUDA error: device-side assert`，一次就废掉整个进程的 CUDA 上下文（只能重启）；服务端 `gen_lock` 与插件的档位并发度共同保证这一点。
- 与其他插件：`dsh-voice`（Edge 在线 TTS/外部 STT）与 `voice-mode`（全双工）**不要同时开**；本插件全程本机，不需要外网。
- 声音与模型不在本目录；服务/ffmpeg/文件通道的路径均写死，移植见 `README.md §0.5`。

## 2026-11-06 修补（v0.6.1）—— 挂断后语音还在播

- **现象**：点挂断，通话状态没了，但语音继续念，甚至新的一段接一段。
- **真因**：挂断只做 `callToggle`（切通话状态），**完全没碰播放侧**——客户端的一次性播放器是全局的，
  队列、`suppressed`、`<audio>` 元素都不归通话管，所以挂断对它等于不存在。
- **修法**：抽出 `stopAllAudio()`（清队列 + 记 `suppressed` + 暂停所有 audio），挂断按钮与
  `interrupt()` 共用；并加一个 `on` 的 true→false 监听，覆盖"宿主判挂 / 会话取消"这些非按钮路径。
- **顺带**：0.6.0 把悬浮条挪到右上后落进 Windows 窗口拖拽带（`-webkit-app-region: drag`），
  整条点不动也拖不动；已改为按 `--dsh-windows-titlebar-height` 让位 + 自身 `no-drag`。

## 2026-11-05 修补（并入 v0.6.0）

- **新增一页版 `使用说明.md`**：开工前五件事 → A 单条语音消息 → B 语音通话 → C 红线 → D 排错 → E 换机器 → F 自检。
  每条都写成「怎么做 / 不能做」两栏，可整份交给别人或新会话。README §0 仍保留更细的判据，两者冲突时以本说明为准。
- **设置面板错位**：面板原先渲染在 `conversation.input.left` 槽位里，那层祖先带 `transform`，
  于是 `position:fixed` 的参照系变成那个祖先——水平看着居中、垂直掉到页面下方还被截断。
  已把面板整体搬到 `shell.overlay`（新组件 `VoiceSettingsPanel` + 模块级开合状态 `settingsOpen`），
  `VoiceInput` 只保留齿轮入口。以后任何「浮在页面上」的 UI 都别挂在输入框槽位里。
- **打断后又重播**：`__voiceTransientClear` 只清队列、停音频，没把被打断的片段记成「已播」；
  `tick()` 每 1.2s 把 `/last-voice` 的 history 重新捡回队列，1.2 秒后又从头念一遍。
  现在打断时把当前片段与队列一起写入 `suppressed` 集合，`tick()` 跳过；同时 `interrupt()`
  不再 `currentTime = 0`（倒带＝把「打断」变成「从头再放」）。

## 2026-11-05 二次修补（v0.6.0）—— 连发多条时只念前半句

- **现象**（用户实测）：连着发好几条语音（长文背诵、多段回答），每一条**只播第一组**，
  后半句全部消失。例：「雄州雾列…宾主尽东南之美。」有，「都督阎公之雅望…」没有。
- **真因**：`/voice-player/next-group` 只服务**当前 `lastVoice`**。agent 连发时第二条一合成，
  `lastVoice` 就被顶掉；前一条的客户端拿着 `?voice=<旧id>` 来取后续组，第 144 行直接判
  `stale` 返回 `done` —— 那一条的剩余组从此再也播不出来。
  （这条检查本意是防串味，但它和「连发不夹 `voice_wait`」的新规矩正好对撞。）
- **修法**：新增 `recentVoices`（id → voice，保留最近 10 条）+ `rememberVoice()`；
  `next-group` 按 id 找到**这一条**自己的分组表，只有 id 查不到才退回 `lastVoice`。
  这样每条语音都能量到底，连发也不会互相截断。
- **过检**：`node --check` 0；`check-voice-stack.py --host http://127.0.0.1:10099` 23 项只剩 1 项红
  （C2 `qwen_tts_server.py` 的发布包漂移，与本次改动无关，未擅自覆盖）。
  发布包 `发布\dsh-voice-stack\plugin\` 已同步。
