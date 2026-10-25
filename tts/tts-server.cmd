@echo off
rem ===========================================================================
rem  tts\tts-server.cmd -- CosyVoice2 TTS service on 127.0.0.1:18081.
rem  ASCII ONLY (cmd reads .cmd as GBK). Override the interpreter with
rem  DSH_VOICE_PY_TTS if your venv lives somewhere else.
rem ===========================================================================
setlocal
set "HERE=%~dp0"
set "ROOT=%HERE%.."
set "PY=%DSH_VOICE_PY_TTS%"
if "%PY%"=="" set "PY=%ROOT%\.venv-tts\Scripts\python.exe"
if not exist "%PY%" (
  echo [tts] python not found: %PY%
  echo [tts] run scripts\install.ps1 first, or set DSH_VOICE_PY_TTS
  exit /b 2
)
"%PY%" "%HERE%tts_server.py" %*
exit /b %errorlevel%
