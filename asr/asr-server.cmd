@echo off
rem ============================================================================
rem dsh-tools\py-asr\asr-server.cmd -- OpenAI-compatible transcription endpoint.
rem
rem WHY: voice-input plugins can point at any /audio/transcriptions endpoint;
rem      this serves the local Qwen3-ASR model on 127.0.0.1:18080.
rem
rem NOTES
rem   * Uses the ASCII junction D:\py-asr (nagisa cannot open non-ASCII paths).
rem   * Keep this file PURE ASCII.
rem   * Health check: curl.exe -s http://127.0.0.1:18080/health
rem ============================================================================
setlocal
set "HERE=%~dp0"
set "ASCII_ROOT=D:\py-asr"
set "PY=%ASCII_ROOT%\.venv\Scripts\python.exe"
set "SCRIPT=%ASCII_ROOT%\asr_server.py"
if not exist "%PY%" (
  set "PY=%HERE%.venv\Scripts\python.exe"
  set "SCRIPT=%HERE%asr_server.py"
)
"%PY%" "%SCRIPT%" %*
exit /b %errorlevel%
