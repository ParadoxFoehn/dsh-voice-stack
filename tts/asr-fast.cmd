@echo off
rem ===========================================================================
rem  asr-fast.cmd -- Qwen3-ASR-0.6B fast lane on 127.0.0.1:18083
rem  ASCII ONLY. Uses the ASCII junction D:\py-asr (non-ASCII paths break deps).
rem ===========================================================================
setlocal
set "PY=D:\py-asr\.venv\Scripts\python.exe"
set "SCRIPT=D:\py-asr\asr_server.py"
set "MODEL=D:\py-asr\models\Qwen3-ASR-0.6B"
if not exist "%PY%" (
  echo [asr-fast] python not found: %PY%
  exit /b 2
)
"%PY%" "%SCRIPT%" --model "%MODEL%" --port 18083 %*
exit /b %errorlevel%
