# @local/dsh-voice-player · v0.3.0

插件的两半：**让 agent 开口说话**（`voice_say` 工具），**让用户录一段发出去**（输入框左侧声波按钮）。
另外从 v0.3.0 起，它还**负责本机两个语音服务的生命周期**——服务是插件的子进程，插件走，服务跟着走。

> 这一版把"服务野在外面"的设计改掉了。旧版用 WMI 把 TTS 起在进程树之外（为了扛客户端重启），
> 代价是插件停用/卸载后服务还在跑、显存不还，而用户没有任何办法关掉它。

## 组成

| 文件 | 职责 |
| --- | --- |
| `index.js` | 宿主：注册 `voice_say`；暴露 status / service / settings 三个端点；插件卸载时杀掉服务 |
| `services.js` | 服务生命周期：spawn、按档位传参、连树杀、`--parent-pid` 看门狗 |
| `config.js` | 档位读写（`config.json`），坏值一律落回默认 |
| `client.js` | 界面：声波按钮、待发托盘、气泡渲染、右键菜单、设置面板 |
| `cordis.patch.yml` | 插入 `voice-player` 一行 |

## 两个本机服务

| 端口 | 服务 | 模型 | 默认档 |
| --- | --- | --- | --- |
| 18082 | Qwen3-TTS | 0.6B（clone 用 Base；design 才用 1.7B） | **CPU 常驻**（0 显存 / 2.6G 内存） |
| 18080 | Qwen3-ASR | **0.6B**（1.7B 只在看视频/复杂音频时显式指定） | GPU + 空闲 120s 卸载（2.3G 显存） |

为什么 TTS 默认放 CPU：**实测同速**（36 字，GPU 2.55 s / CPU 2.50 s，0.98×）。
TTS 是自回归逐字生成，`batch=1` 时是串行延迟瓶颈，显卡并行度用不上。省下的 2.3 G 显存比省下的内存值钱。

## 生命周期（v0.3.0 的核心改动）

```
插件加载        → 只注册，不起服务（零占用）
点灰色按钮      → 宿主 spawn 服务（带 --parent-pid）→ 就绪
右键「关闭」    → 连进程树杀掉
插件停用/卸载   → dispose 里 stopAll()
插件进程崩溃    → 服务侧看门狗发现父进程消失 → 自杀
```

三条保证：**插件死服务死**（看门狗）、**卸载即清**（`stopAll`）、**不留孤儿**（`taskkill /T` 连子树）。

## 用户怎么用

- **左键**：录音 → 进待发托盘 → 「发送 N 条」。服务没起时，这一次点击是"启动服务"，按钮会变灰。
- **右键**：菜单两项 —— 开启/关闭语音服务、设置…
- **设置面板**：TTS 两栏（常驻 / 空闲卸载 + 秒数；GPU / CPU）+ ASR 一栏（常驻 / 空闲卸载），
  底部实时显示预计占用。改动在**重新开启服务后**生效。

## 助手怎么用

见技能 `speak`。规则本体写在 `index.js` 的 `systemPrompt.section`（三行，约 120 token/轮）：
用户发语音 → 必须用 `voice_say` 回一条语音（20 秒内），细节留给文字。

## HTTP 端点（宿主侧）

| 端点 | 方法 | 作用 |
| --- | --- | --- |
| `/voice-player/status` | GET | 两个服务是否在跑 + 当前档位 |
| `/voice-player/service?target=tts&action=start\|stop` | POST | 开关单个服务 |
| `/voice-player/settings` | GET / POST | 读 / 写档位 |
| `/voice-player/ensure` | GET | 兼容旧调用：确保 TTS 在跑 |
| `/voice-player/last-voice` | GET | 最近一段合成的音频（客户端据此播放一次） |
| `/voice-player/probe-send` | POST | 把语音标记投递到指定会话（**必须带 sessionId**） |
| `/voice-player/bubble-report` | GET/POST | 气泡渲染诊断 |

## 配置（`config.json`，运行时生成）

```json
{
  "asr": { "mode": "idle", "idleSec": 120 },
  "tts": { "mode": "resident", "idleSec": 120, "device": "cpu" }
}
```

`mode`: `resident` | `idle`；`device`: `gpu` | `cpu`。范围：`idleSec` 30–3600 秒。

## 显存参考（实测，RTX 5090 Laptop）

| 组合 | 显存 | 内存 |
| --- | --- | --- |
| ASR 0.6B(GPU) + TTS 0.6B(CPU) ← **默认** | 2.3 G | 3.0 G |
| ASR 0.6B(GPU) + TTS 0.6B(GPU) | 4.6 G | 1.3 G |
| 会议模式：ASR 1.7B(GPU) + TTS CPU | 4.7 G | 3.0 G |

## 已知坑

- **中文路径**：所有服务调用必须走 ASCII junction（`D:\py-tts`、`D:\py-asr`），
  否则 `nagisa` / `wetext` 这些 C++ 依赖读不了文件。
- **`<audio>` 标签会被消息渲染层过滤**；播放器要走 `#vcp-root` + `iframe`，或走气泡渲染的那条路。
- **别挂 `turnTail` 自动播放器**：会让每条回复后面都跟一条重复语音（2026-10-24 移除）。
- **不要用 WMI 起服务**：那是旧版的做法，会让服务脱离插件生命周期（见上）。
- 改完插件要**重启客户端**才生效（宿主与客户端半边都在启动时加载）。

## 版本

- **0.3.0**（2026-10-30）服务归插件托管（spawn / 看门狗 / 卸载清理）；新增档位配置、
  右键菜单、设置面板；TTS 默认走 CPU；ASR 默认 0.6B。
- 0.2.0 — 待发托盘、v2 气泡、`probe-send` 会话绑定。
- 0.1.0 — `voice_say` + 极简播放器。
