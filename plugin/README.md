# @local/dsh-voice-player

本机语音能力的**宿主侧与工具侧**：注册 `voice_say` 工具，让 agent 主动"开口说话"。
播放器渲染走 `speak` 技能的透明容器（见下），因为工具调用卡在界面上默认折叠，不适合放播放器。

## 组成

- `index.js`（host）：注册工具 `voice_say(text)` → 预热调用本机 CosyVoice2（`127.0.0.1:18081/say`），失败回退 SAPI（`18080/tts`）。
- `client.js`（web）：`tool.call.toolview` 的 `voice_say` 视图（极简原生播放器；工具卡折叠时看不到，属正常）。
- `cordis.patch.yml`：插入 `voice-player` 行。

## 依赖的本机服务

| 端口 | 服务 | 目录 | 启动 |
| --- | --- | --- | --- |
| 18081 | CosyVoice2 TTS（懒加载，冷 16 s / 热 1 s） | `dsh-tools\py-tts` | `tts-server.cmd`（由守护拉起） |
| 18080 | Qwen3-ASR + 播放页/静态音频 | `dsh-tools\py-asr` | `asr-server.cmd` |

守护：`dsh-tools\py-asr\guard-asr.ps1`（通用化：`-Port/-Server/-LogName`），启动目录 `DSH-ASR-Guard.cmd` 同时拉两个；客户端退出即停。
手动重启：`dsh-tools\py-asr\restart-guards.ps1`。

## 怎么发语音

见技能 **`speak`**（`D:\Harness工作区\.dsh\skills\speak\SKILL.md`）：
`voice_say` 预热 → 取 `/last` 的 `file` → 透明容器 + `iframe` 播放器 → 空行 + 文字复述。

## 本机补丁与已知坑

- 中文路径：所有 TTS/ASR 调用必须走 ASCII junction（`D:\py-tts`、`D:\py-asr`），否则 cog/nagisa/wetext 等 C++ 依赖读不了文件。
- 控制台闪烁：所有 `subprocess` 已加 `CREATE_NO_WINDOW`；服务用 WMI 脱离控制台启动（`guard-asr.ps1`）。
- 别挂 `conversation.chat.turnTail` 自动播放器：那版代码有 bug，会让**每条回复后面都跟一条重复的语音**（2026-10-24 移除）。注意这是**实现 bug**，不是"用户不想听语音"——用户要的恰恰是"我说语音，你回语音"，只是每条只能有一条，不能叠加。
- `<audio>` 标签会被消息渲染层过滤；`<iframe>` 必须包在 `#vcp-root` 里才渲染。

## 助手的回话规则（插件自带，改动见 `index.js` 顶部 `systemPrompt.section`）

`index.js` 往系统提示里写了一条**三行**的规则（约 120 token/轮）：

> 对话里出现 `【语音 N.Ns】http…` 标记 ＝ 用户刚发来一条语音 → **必须先用 `voice_say` 回一条语音**（先说要点，20 秒以内），细节留给文字；用户只打字时不适用。

装了这个插件，"别人家的小肥鱼"也会照做——用户发语音、AI 用语音回。不想要这条，删掉 `index.js` 里那个 `systemPrompt.section({...})` 即可，其余功能不受影响。

## 用户侧：录一条语音发出去（2026-10-27 定稿）

输入框左侧的**声波按钮**：点一下 → 探活语音服务（没起就自动拉起）→ 录音 → 录完进**待发托盘**（右下角浮层）。

- 托盘里每条可试听、可 `×` 撤回；底部「发送 N 条」一次发出。
- 发出后是**一条消息、N 个标记**，渲染层按标记拆成 N 个独立播放器气泡。
- **不经过输入框**：走宿主路由 `/voice-player/probe-send` → `sessionController.prompt()`（与定时提醒同一扇门），所以不存在"文字闪进输入框""发送后残留在框里"这些问题。

## 可调参数（改完重启客户端生效）

都在 `client.js` 顶部，一处改完即可：

| 常量 | 默认 | 含义 |
| --- | --- | --- |
| `MAX_DRAFTS` | `3` | 待发托盘最多攒几条，满了拒绝新录音并提示 |
| `MAX_SECONDS` | `30` | 单条录音硬上限（秒），到点自动停止 |
| `WARN_SECONDS` | `20` | 录到多少秒开始提示"已偏长"（不打断） |

**想一次攒更多条，就改 `MAX_DRAFTS`**——文件里那段注释写着依据：0.6B 快道实测 22.2 秒能完整正确转写；模型的音频位置上限 `max_source_positions = 1500` 换算约 60 秒，是硬边界，但长句的断句与标点会变差，所以默认取 30 秒。托盘上限只影响体验（一次塞太多条，我在一条消息里读起来也吃力），技术上没有硬限制。

## 助手侧：说一条语音（2026-10-28 定稿）

`voice_say(text)` 一旦被调用：

1. 宿主 `ensureTts()` 确保 18082 在跑（没起就 WMI 拉起），然后 `/say` **整段合成** mp3，读 `/last` 得到 `{file, sec}`，记进 `lastVoice`；
2. 消息里给一张**白底淡蓝边卡片**（`/player?file=…`，不自动播）= 重听入口；
3. **客户端每 1.2 s 轮询 `/voice-player/last-voice`**：文件不在 `localStorage['dsh-voice-played']` 里，就在 `body` 上挂一个不可见 `<audio>`，自动播放**一次**；`ended` 时写记号并立刻移除元素。

为什么这样：消息列表是虚拟化的，**滚出视口就卸载**，放在消息里的 `<audio>`/iframe 会重载、从头播。播放器放插件层，就与滚动无关；判据用"**播完才做记号**"而不是时间窗——时间不知道用户听没听。加载失败不写记号，宁可下次再响。

诊断：`GET /voice-player/bubble-report` 能读到客户端气泡扫描的现场（`count / diag / bodyHits`），排障不用开 devtools。
