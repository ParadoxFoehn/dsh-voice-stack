# RELEASE —— 发布到 GitHub 的具体流程

本项目**不需要**发布成 npm 包：网友是 `git clone` 之后跑脚本，插件由 DSH 的插件管理器"从本地目录安装 bundle"。

## 0. 发布前自查（用当前这台机器就能做）

```powershell
# 1) 脚本编码/裸 python 检查（本仓库所有 .ps1/.cmd 必须纯 ASCII）
python -c "import sys; sys.exit(0)"      # 只是确认解释器在
# 用你自己的检查脚本，或人工确认：所有 .ps1/.cmd 无中文、无 BOM

# 2) PowerShell 语法
Get-ChildItem -Recurse -Filter *.ps1 | ForEach-Object {
  $e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$null, [ref]$e)
  if ($e) { "$($_.Name): $($e[0].Message)" } else { "OK $($_.Name)" }
}

# 3) Python 编译
python -m compileall -q tts asr scripts

# 4) JSON 合法性
Get-ChildItem -Recurse -Filter *.json | ForEach-Object {
  try { Get-Content $_ -Raw | ConvertFrom-Json | Out-Null } catch { "BAD $_" }
}
```

## 1. 初始化仓库

```powershell
cd D:\dsh-voice-stack           # 仓库根（不要把 models/ third_party/ .venv-* 带进去）
git init
git branch -M main
# 把 plugin/package.json 里的 repository.url 改成你的仓库地址
git add .
git status                      # 确认没有 models/ 或 venv 被暂存（.gitignore 已挡住）
git commit -m "feat: local voice stack (CosyVoice2 TTS + Qwen3-ASR) for DSH"
```

## 2. 在 GitHub 建仓库并推送

```powershell
# 用 gh（已登录）：
gh repo create dsh-voice-stack --public --source . --remote origin --push --description "让桌面 AI 用自己的声音说话：CosyVoice2 + Qwen3-ASR + DSH 插件与技能"

# 或者手工：先在网页建空仓库，然后
git remote add origin https://github.com/ParadoxFoehn/dsh-voice-stack.git
git push -u origin main
```

仓库设置建议：

- **Topics**：`dsh` `deepseek-harness` `tts` `asr` `cosyvoice` `qwen` `local-ai` `windows`
- **About**：一句话 + README 链接
- **Issues**：打开，加一个 `environment` 模板（要求附 `nvidia-smi` / `python -V` / `verify.ps1` 输出）
- **Releases**：打 tag `v0.1.0`，附 `dsh-voice-stack-v0.1.0.zip`（源码包，不含模型）

## 3. 打 tag 与 Release

```powershell
git tag -a v0.1.0 -m "0.1.0: first public build"
git push origin v0.1.0
gh release create v0.1.0 --title "v0.1.0" --notes-file CHANGELOG.md `
  "dsh-voice-stack-v0.1.0.zip#源码包（不含模型与虚拟环境）"
```

## 4. 网友怎么装（写进 README 的那一段）

```powershell
git clone https://github.com/ParadoxFoehn/dsh-voice-stack.git D:\dsh-voice-stack
cd D:\dsh-voice-stack
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify.ps1
```

然后：

1. 插件：DSH 插件管理器 → 安装 bundle → 选 `D:\dsh-voice-stack\plugin`（包名 `@local/dsh-voice-player`）；
2. **在插件配置里把 `stackDir` 填成 `D:\dsh-voice-stack`**（不填就只能用 SAPI 兜底）；
3. 技能：把 `skill\speak` 复制到 `<DSH_HOME>\.dsh\skills\speak\`；
4. 完全重启 DSH 客户端。

## 5. 不要提交的东西

`.gitignore` 已排除：`models/`、`third_party/`、`.venv-asr/`、`.venv-tts/`、`tts/out/`、`shared_voice/`、`logs/`、`assets/prompt.wav`、`config/config.json`。

> 特别是 `assets/prompt.wav`：如果你换成了**自己的声音**做参考音，它属于个人数据，不要进仓库。默认版本由安装脚本本机生成。

## 6. 版本与许可

- 本仓库代码 MIT；第三方（模型/源码/SAPI/ffmpeg）许可见 `THIRD-PARTY-NOTICES.md`，别删。
- 模型**不随仓库分发**，由 `scripts/download-models.py` 从 ModelScope 下载，遵守 Apache-2.0。
- 语音克隆边界写在 `THIRD-PARTY-NOTICES.md` 最后一节：不要用他人声音克隆后公开分发。

## 7. 收集反馈的方式

README 里已经明确写：**先在沙箱/虚拟机试，反馈到 Issues**。建议在 Issue 模板里固定三样东西：

1. `nvidia-smi`（确认显卡/驱动/显存）
2. `python -V` 与 `ffmpeg -version` 第一行
3. `scripts\verify.ps1` 的完整输出

这三样能覆盖 90% 的环境类问题。
