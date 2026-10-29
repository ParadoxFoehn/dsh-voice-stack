@echo off
rem ===========================================================================
rem  qwen-tts-server.cmd -- Qwen3-TTS service (VoiceDesign 1.7B) on 127.0.0.1:18082
rem  ASCII ONLY. Uses the .venv-qwen environment (transformers 5 based).
rem ===========================================================================
setlocal
set "PY=D:\py-tts\.venv-qwen\Scripts\python.exe"
set "SCRIPT=D:\py-tts\qwen_tts_server.py"
if not exist "%PY%" (
  echo [qwen-tts] python not found: %PY%
  exit /b 2
)
"%PY%" "%SCRIPT%" --port 18082 %*
exit /b %errorlevel%
