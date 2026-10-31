@echo off
setlocal
cd /d "%~dp0"
set "STATION_NODE="
for /f "delims=" %%N in ('%SystemRoot%\System32\where.exe node.exe 2^>nul') do if not defined STATION_NODE set "STATION_NODE=%%N"
if not defined STATION_NODE if exist "%ProgramFiles%\nodejs\node.exe" set "STATION_NODE=%ProgramFiles%\nodejs\node.exe"
if not defined STATION_NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "STATION_NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined STATION_NODE if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "STATION_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not defined STATION_NODE (
  echo Node.js 22+ was not found. Install Node.js, then double-click this file again.
  pause
  exit /b 1
)
echo Building and launching AhaStation. This window closes after launch.
set "STATION_ROOT=%~dp0"
rem Kernel mutex protects builds; a crashed launcher cannot leave a stale lock.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command "$key=[Convert]::ToBase64String([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($env:STATION_ROOT.ToUpperInvariant()))).Replace('/','_'); $name='Local\AhaStation-build-'+[Security.Principal.WindowsIdentity]::GetCurrent().User.Value+'-'+$key; $m=New-Object Threading.Mutex($false,$name); $owned=$false; try { try {$owned=$m.WaitOne(0)} catch [Threading.AbandonedMutexException] {$owned=$true}; if (!$owned) {Write-Host 'AhaStation is already building. Wait for that launcher to finish.'; exit 2}; & $env:STATION_NODE (Join-Path $env:STATION_ROOT 'scripts\launch-station.mjs'); exit $LASTEXITCODE } finally {if ($owned) {$m.ReleaseMutex()}; $m.Dispose()}"
if errorlevel 1 (
  echo Launch failed. Read the error and log path above.
  pause
  exit /b 1
)
endlocal
