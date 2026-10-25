# INSTALL

一步一步来。全程 Windows PowerShell（不需要管理员权限）。

## 0. 前置检查

```powershell
python -V            # 需要 3.12（3.11/3.13 也可以试试）
ffmpeg -version      # 没有的话：winget install Gyan.FFmpeg
nvidia-smi           # 有输出说明驱动就绪；没有就是纯 CPU 模式
```

把仓库放在**纯 ASCII 路径**下（例如 `D:\dsh-voice-stack`）。中文路径会让 `wetext` / `nagisa` / 部分 onnx 运行时报"打不开文件"。
已经放在中文路径也没关系，建一个 junction 即可：

```powershell
cmd /c mklink /J D:\dsh-voice "D:\你的路径\dsh-voice-stack"
```

## 1. 一键安装

```powershell
cd D:\dsh-voice
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1
```

它做这些事（可重复执行，已完成的会跳过）：

| 步骤 | 说明 |
| --- | --- |
| 1 | 找 Python 3.12、检查 ffmpeg |
| 2 | 建 `.venv-asr`、`.venv-tts` 两个虚拟环境（**必须分开**，依赖互斥） |
| 3 | 装 torch/torchaudio（默认 cu128 轮子，约 2.7 GB）+ 各自 requirements |
| 4 | 拉 CosyVoice **v2.0** 源码与 Matcha-TTS 到 `third_party\`，并给 `load_wav` 打补丁 |
| 5 | 从 ModelScope 下载两个模型（约 8.8 GB，可断点重跑） |
| 6 | 用 Windows SAPI 生成 `assets\prompt.wav`（3 秒参考音，音色种子） |
| 7 | 生成 `config\config.json` |

可选参数：

```powershell
-FindPython "C:\...\python.exe"   # 指定解释器
-TorchIndex <url>                 # 换 CUDA 轮子源（cu121 / 国内镜像）
-PipIndex <url>                   # 换 pip 源
-GitHubProxy <url>                # 换 GitHub 代理（默认 https://gh-proxy.com/）
-SkipModels                       # 先不下载模型
-SkipSource                       # 先不拉源码
-Force                            # 重建 venv / 覆盖 config
```

## 2. 自检

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify.ps1
```

它会检查文件、两个服务、合成一句、再用 ASR 读回来比对。全 PASS 时会打印 `ALL CHECKS PASSED` 且退出码为 0。

先启动服务（若还没跑）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\restart-guards.ps1
```

## 3. 装插件（DSH 客户端）

1. 把 `plugin\` 目录作为 bundle 装进你的 profile（DSH 的插件管理器支持"从本地目录安装 bundle"）；
2. 它注册的工具名是 `voice_say`，包名 `@local/dsh-voice-player`；
3. 装完**完全重启** DSH 客户端（宿主侧模块要重新加载）。

## 4. 装技能

把 `skill\speak\` 整个目录复制到：

```
<DSH_HOME>\.dsh\skills\speak\
```

重启客户端后在技能列表里应能看到 `speak`。之后只要说"用语音回答 / 说句话给我听"，agent 就会按固定流程发一条语音消息。

## 5. 开机自启（可选，默认不做）

语音服务默认**不随开机启动**：第一次用到时由插件按需拉起（`voice_say` 会探测 18081 并启动），也可以在本地模型悬浮窗里手动「启动」。下面的自启脚本只在你想让它开机就监听时才需要。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-startup.ps1
```

在"启动"文件夹写一个 `.cmd`，登录时拉起两个守护进程。删除那个文件即可撤销。

## 6. 第一次用

- 第一次合成要加载模型，等 10–20 秒；
- 之后一句话 1–3 秒；
- 想让音色变成"你自己的"：录 3–5 秒 16 kHz 单声道 WAV，替换 `assets/prompt.wav`，并把 `config\config.json` 里的 `prompt_text` 改成那段录音的**准确原文**，重启服务。

## 卸载

删掉整个仓库目录，再删"启动"文件夹里的 `DSH-Voice-Guard.cmd`（如果装过自启）。
模型与 venv 都在仓库内，不会污染系统。

## 常见问题

见 [docs/troubleshooting.md](docs/troubleshooting.md)。最常遇到的两个：

- **显存不够**：先看是不是 ComfyUI 之类的应用占着显存；
- **声音不对/内容乱**：CosyVoice 用了 `main` 分支而不是 `v2.0` 标签。
