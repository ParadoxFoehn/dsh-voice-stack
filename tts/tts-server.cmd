@echo off
rem ============================================================================
rem py-tts\tts-server.cmd -- local CosyVoice2 TTS service (127.0.0.1:18081).
rem ASCII ONLY. Uses the ASCII junction D:\py-tts (Chinese paths break some deps).
rem ============================================================================
setlocal
set "PY=D:\py-tts\.venv\Scripts\python.exe"
set "SCRIPT=D:\py-tts\tts_server.py"
"%PY%" "%SCRIPT%" %*
exit /b %errorlevel%
