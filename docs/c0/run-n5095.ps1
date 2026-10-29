# C0 one-shot runner for the N5095 (Windows x64). ASCII only so Windows PowerShell 5.1 reads it correctly.
#
# Usage, from the repo root in PowerShell:
#   powershell -ExecutionPolicy Bypass -File docs\c0\run-n5095.ps1                 # B05 voice benchmark
#   powershell -ExecutionPolicy Bypass -File docs\c0\run-n5095.ps1 -RunBaseline    # + B01/B02 Windows clean install and tests
#
# Results go to docs\c0\results\ (small JSON + wav samples). Models and venv go to -WorkDir (outside the repo).
# Nothing here reads credentials, calls paid models, or writes outside -WorkDir and docs\c0\results.
param(
  [string]$WorkDir = "$env:USERPROFILE\aha-c0",
  [string]$HfHost = "huggingface.co",        # use hf-mirror.com if huggingface.co is slow
  [string]$PipIndex = "",                    # e.g. https://pypi.tuna.tsinghua.edu.cn/simple
  [int[]]$Threads = @(1, 2, 4),
  [switch]$SkipBench,
  [switch]$RunBaseline
)
$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
$Results = Join-Path $RepoRoot "docs\c0\results"
$Stamp = Get-Date -Format "yyyyMMdd-HHmm"
$HostTag = "$($env:COMPUTERNAME)-$Stamp".ToLower()
New-Item -ItemType Directory -Force -Path $WorkDir, $Results | Out-Null

function Get-File([string]$Url, [string]$Out) {
  for ($i = 1; $i -le 5; $i++) {
    & curl.exe -sSL --retry 3 -C - -o $Out $Url
    if ($LASTEXITCODE -eq 0) { return }
    Write-Host "  retry $i ($Url) exit $LASTEXITCODE"
  }
  throw "download failed: $Url"
}

# ---- host facts --------------------------------------------------------------
$cpu = (Get-CimInstance Win32_Processor | Select-Object -First 1)
$bat = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
$meta = [ordered]@{
  host = $env:COMPUTERNAME; stamp = $Stamp; cpu = $cpu.Name; cores = $cpu.NumberOfCores; threads = $cpu.NumberOfLogicalProcessors
  ramGB = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)
  os = (Get-CimInstance Win32_OperatingSystem).Caption + " " + (Get-CimInstance Win32_OperatingSystem).Version
  battery = if ($bat) { @{ status = $bat.BatteryStatus; charge = $bat.EstimatedChargeRemaining; note = "BatteryStatus 2 = on AC" } } else { "none" }
  gitHead = (& git -C $RepoRoot rev-parse HEAD)
}
$meta | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 (Join-Path $Results "$HostTag-meta.json")
Write-Host "CPU: $($meta.cpu)  RAM: $($meta.ramGB) GB  HEAD: $($meta.gitHead)"

# ---- B05 voice benchmark -----------------------------------------------------
if (-not $SkipBench) {
  $py = $null
  foreach ($c in @("py -3", "python")) {
    try { $v = Invoke-Expression "$c --version" 2>&1; if ($LASTEXITCODE -eq 0) { $py = $c; break } } catch {}
  }
  if (-not $py) { throw "Python 3.9+ not found. Install from python.org (tick 'Add to PATH') and re-run." }
  $venv = Join-Path $WorkDir ".venv"
  if (-not (Test-Path "$venv\Scripts\python.exe")) { Invoke-Expression "$py -m venv `"$venv`"" }
  $vpy = "$venv\Scripts\python.exe"
  $pipArgs = @("-m", "pip", "install", "-q", "sherpa-onnx==1.13.8", "numpy", "soundfile")
  if ($PipIndex) { $pipArgs += @("-i", $PipIndex) }
  & $vpy @pipArgs
  if ($LASTEXITCODE -ne 0) { throw "pip install failed" }

  $models = Join-Path $WorkDir "models"; $dl = Join-Path $WorkDir "downloads"
  New-Item -ItemType Directory -Force -Path $models, $dl | Out-Null
  $gh = "https://github.com/k2-fsa/sherpa-onnx/releases/download"
  foreach ($t in @("tts-models/vits-icefall-zh-aishell3", "tts-models/kokoro-int8-multi-lang-v1_1")) {
    $name = Split-Path $t -Leaf
    if (-not (Test-Path (Join-Path $models $name))) {
      Write-Host "download $name"
      $arc = Join-Path $dl "$name.tar.bz2"
      Get-File "$gh/$t.tar.bz2" $arc
      & tar.exe -xjf $arc -C $models
      if ($LASTEXITCODE -ne 0) { Remove-Item $arc; throw "extract failed for $name (archive removed, re-run to retry)" }
    }
  }
  $asr = "sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30"
  $asrDir = Join-Path $models $asr
  New-Item -ItemType Directory -Force -Path "$asrDir\test_wavs" | Out-Null
  foreach ($f in @("decoder.onnx", "encoder.int8.onnx", "joiner.int8.onnx", "tokens.txt", "test_wavs/0.wav", "test_wavs/1.wav")) {
    $outF = Join-Path $asrDir ($f -replace "/", "\")
    if (-not (Test-Path $outF)) { Write-Host "download $asr/$f"; Get-File "https://$HfHost/csukuangfj/$asr/resolve/main/$f" $outF }
  }

  $out = Join-Path $Results "$HostTag-voice.json"
  $threadArgs = $Threads | ForEach-Object { "$_" }
  & $vpy (Join-Path $PSScriptRoot "b05-voice\bench_voice.py") --models $models --out $out --threads @threadArgs
  if ($LASTEXITCODE -ne 0) { throw "bench_voice.py failed" }
  Write-Host "voice result: $out"
}

# ---- B01/B02 on Windows: clean install, typecheck, build, tests --------------
if ($RunBaseline) {
  $nodeV = (& node -v)
  Write-Host "node $nodeV npm $(& npm -v)"
  if ($nodeV -notmatch "^v22\.") { Write-Host "WARNING: CI uses Node 22; this machine has $nodeV. Results will be marked as such." }
  $logs = Join-Path $WorkDir "b01-$Stamp"; New-Item -ItemType Directory -Force -Path $logs | Out-Null
  $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
  $summary = [ordered]@{ node = $nodeV; npm = (& npm -v); gitHead = $meta.gitHead; steps = [ordered]@{} }
  Push-Location $RepoRoot
  try {
    foreach ($step in @(@("npm-ci", "ci"), @("typecheck", "run typecheck"), @("build", "run build"), @("test", "test"))) {
      $log = Join-Path $logs "$($step[0]).log"
      Write-Host "npm $($step[1]) ..."
      cmd /c "npm $($step[1]) > `"$log`" 2>&1"
      $code = $LASTEXITCODE
      $summary.steps[$step[0]] = @{ exitCode = $code; logSha256 = (Get-FileHash $log -Algorithm SHA256).Hash.ToLower() }
      if ($step[0] -eq "test") {
        $tail = Get-Content -Encoding UTF8 $log | Where-Object { $_ -match "^(# |. )(tests|pass|fail|skipped) \d+" }
        $summary.steps.test.summary = $tail
        $summary.steps.test.failed = @(Get-Content -Encoding UTF8 $log | Where-Object { $_ -match "^not ok " })
      }
      Write-Host "  exit $code"
      if ($code -ne 0 -and $step[0] -ne "test") { break }
    }
  } finally { Pop-Location }
  $summary | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 (Join-Path $Results "$HostTag-b01.json")
  Write-Host "baseline result: $(Join-Path $Results "$HostTag-b01.json")  (full logs: $logs)"
}

Write-Host ""
Write-Host "Done. To send results back:"
Write-Host "  git add docs/c0/results && git commit -m `"C0 N5095 results $HostTag`" && git push"
