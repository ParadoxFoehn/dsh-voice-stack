# @local/dsh-voice-player

DSH 插件：给助手一张嘴——注册 `voice_say` 工具，并提供极简播放器视图。

## 组成

| 文件 | 作用 |
| --- | --- |
| `index.js` | 宿主侧：`ctx.tools.register('voice_say')`。收到文本先请求 TTS 服务预热合成（18081），失败回退 SAPI（18080）。 |
| `client.js` | 客户端侧：`tool.call.toolview` 的 `voice_say` 视图，一个原生播放器（无卡片样式）。工具卡在界面上默认折叠，所以正式投放的播放器由技能 `speak` 用透明容器 iframe 输出。 |
| `cordis.patch.yml` | 插入插件行 `voice-player`。 |
| `locale/*.json` `icon.svg` | 插件管理面板里的标题、描述、图标。 |

## 依赖的服务

| 端口 | 服务 | 说明 |
| --- | --- | --- |
| 18081 | CosyVoice2 TTS | `/say?text=` 合成（按文本缓存）、`/player?file=` 播放页、`/last` 最近一句 |
| 18080 | Qwen3-ASR | `/v1/audio/transcriptions` 转写、`/voice/*` 静态音频、`/player`、`/tts`（SAPI 兜底） |

两者都由 `scripts/restart-guards.ps1` 拉起，随客户端进程起落。

## 配置

`cordis.patch.yml` 里有三个键：

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `stackDir` | 空 | 本仓库在你机器上的绝对路径，例如 `D:\\dsh-voice-stack`。用于"服务没起时自动拉起 TTS"；留空则只能用 SAPI 兜底 |
| `ttsPort` | 18081 | CosyVoice2 服务端口 |
| `sapiPort` | 18080 | ASR / SAPI 兜底端口 |

环境变量 `DSH_VOICE_STACK` 可以覆盖 `stackDir`。

## 安装

把本目录作为 bundle 装进 DSH profile，然后**完全重启客户端**（宿主侧模块要重新加载）。

## 怎么用

见技能 `speak`：`voice_say` 预热 → 取 `/last` 的文件名 → 透明容器 + iframe 播放器 → 空行 + 文字复述。

## 四条硬规则（都是踩出来的）

1. 消息里的 HTML 必须包 `#vcp-root`，否则显示成代码；
2. 播放器容器要**透明、零内边距**，否则会被看成卡片；
3. `<audio>` 标签会被消息渲染层过滤，别用；
4. 播放器和正文之间留空行（`margin-bottom` + 空行）。

## 已知坑

- 不要在 `conversation.chat.turnTail` 挂自动播放器：会在每轮回复下面都冒出一条"我的语音"。
- 工具调用卡默认折叠，把播放器只放在 toolview 里用户看不见。
- 音色取决于 TTS 服务的参考音 `assets/prompt.wav`，不是这个插件决定的。
