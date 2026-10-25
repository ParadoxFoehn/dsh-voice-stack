@echo off
rem ===========================================================================
rem  asr\asr-server.cmd -- Qwen3-ASR endpoint on 127.0.0.1:18080. It also serves
rem  /voice/* and /player, which the chat uses to play spoken replies.
rem  ASCII ONLY. Override the interpreter with DSH_VOICE_PY_ASR.
rem ===========================================================================
setlocal
set "HERE=%~dp0"
set "ROOT=%HERE%.."
set "PY=%DSH_VOICE_PY_ASR%"
if "%PY%"=="" set "PY=%ROOT%\.venv-asr\Scripts\python.exe"
if not exist "%PY%" (
  echo [asr] python not found: %PY%
  echo [asr] run scripts\install.ps1 first, or set DSH_VOICE_PY_ASR
  exit /b 2
)
"%PY%" "%HERE%asr_server.py" %*
exit /b %errorlevel%
