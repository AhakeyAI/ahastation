# Runs the B04 matrix sequentially on Windows. Prereqs: portable Node 22 at
# %USERPROFILE%\aha-c0\node22, Paseo 0.12.0 daemon running (paseo daemon start
# --home %USERPROFILE%\aha-c0\paseo-home), dist-electron built, and for C-A2 an
# experimental dist copy at .b04-dist-codex-0156 with the Codex pin set to 0.156.1.
param([string]$Only = "")
$ErrorActionPreference = "Continue"
$repo = (Resolve-Path "$PSScriptRoot\..\..\..\..").Path
Set-Location $repo
$env:PATH = "$env:USERPROFILE\aha-c0\node22\node-v22.23.4-win-x64;" + $env:PATH
$stub = "data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('./tests/electron-stub.mjs', pathToFileURL('./'));"
$runner = "docs/c0/b04-runtime/harness/run.mjs"
$codexExe = (Get-ChildItem "C:\Users\shawn\AppData\Local\Programs\nodejs\node_modules\@openai\codex" -Recurse -Filter codex.exe | Select-Object -First 1).FullName

"=== C-A claude-code"; node --import $stub $runner C-A claude-code $Only

"=== C-A2 codex (experimental: Codex pin bumped to 0.156.1)"
$env:B04_DIST = "$repo\.b04-dist-codex-0156"; $env:B04_CODEX_BIN = $codexExe; $env:B04_CODEX_VERSION = "0.156.1"
node --import $stub $runner C-A codex $Only
Remove-Item Env:B04_DIST, Env:B04_CODEX_BIN, Env:B04_CODEX_VERSION

"=== C-P claude-code"; node $runner C-P claude-code $Only
"=== C-P codex"; node $runner C-P codex $Only
"=== done"
