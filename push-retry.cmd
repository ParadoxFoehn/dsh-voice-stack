@echo off
rem push-retry.cmd -- push D:\dsh-release to GitHub, retrying because github.com:443
rem is intermittent on this network (measured 2026-10-28: 1 success in 3 attempts).
rem ASCII ONLY: cmd reads this file as ANSI/GBK.
setlocal
set REPO=D:\dsh-release

echo === checking connectivity ===
powershell -NoProfile -Command "if ((Test-NetConnection github.com -Port 443 -WarningAction SilentlyContinue).TcpTestSucceeded) { 'github:443 OK' } else { 'github:443 DOWN (will still try)' }"

for /L %%i in (1,1,10) do (
  echo.
  echo [attempt %%i of 10]
  git -C "%REPO%" push origin main
  if not errorlevel 1 goto ok
  echo [retry] waiting 6s ...
  timeout /t 6 /nobreak >nul
)
echo.
echo [FAILED] all 10 attempts failed. Network to github.com is unstable right now.
goto end

:ok
echo.
echo [OK] push finished. Verify on the web page, then run the tree check again.

:end
echo.
pause
endlocal
