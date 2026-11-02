param([string]$Role)
$probeRoot = $env:AHA_D1_DATA
@{ pid = $PID; role = $Role } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $probeRoot "probe-$Role.json") -Encoding UTF8
if (!$Role.Contains('-grandchild')) {
  $nextRole = if ($Role.Contains('-child')) { "$Role-grandchild" } else { "$Role-child" }
  Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList @('-NoProfile', '-File', "`"$PSCommandPath`"", $nextRole) -WindowStyle Hidden | Out-Null
}
if ($Role.Contains('-child')) { while ($true) { Start-Sleep -Milliseconds 500 } }
while ($true) {
  $inputText = ''
  while ([Console]::KeyAvailable) { $inputText += [Console]::ReadKey($true).KeyChar }
  if ($inputText) { [Console]::WriteLine("ACK:${Role}:${inputText}:SIZE:$([Console]::WindowWidth)x$([Console]::WindowHeight)") }
  [Console]::WriteLine("TICK:${Role}:${PID}")
  Start-Sleep -Milliseconds 250
}
