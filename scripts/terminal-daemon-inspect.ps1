param([string]$RootIds, [string]$DataDir, [string]$PipeName)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class D1Native {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("advapi32.dll")] public static extern uint GetSecurityInfo(IntPtr handle, int type, uint info, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(IntPtr descriptor, uint revision, uint info, out IntPtr text, out uint length);
  [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr pointer);
}
'@
$processes = @{}
$pendingIds = [Collections.Generic.Queue[int]]::new()
foreach ($rootId in $RootIds.Split(',')) { $pendingIds.Enqueue([int]$rootId) }
while ($pendingIds.Count -gt 0) {
  $nextId = $pendingIds.Dequeue()
  if ($processes.ContainsKey($nextId)) { continue }
  $owned = Get-CimInstance Win32_Process -Filter "ProcessId=$nextId"
  if (!$owned) { continue }
  $inJob = $false
  $handle = [D1Native]::OpenProcess(0x1000, $false, $nextId)
  if ($handle -eq [IntPtr]::Zero) { throw "Cannot inspect own process $nextId" }
  try { if (![D1Native]::IsProcessInJob($handle, [IntPtr]::Zero, [ref]$inJob)) { throw 'IsProcessInJob failed' } }
  finally { [D1Native]::CloseHandle($handle) | Out-Null }
  $processes[$nextId] = [PSCustomObject]@{ ProcessId = $owned.ProcessId; ParentProcessId = $owned.ParentProcessId;
    CreationDate = $owned.CreationDate.ToUniversalTime().ToString('o'); ExecutablePath = $owned.ExecutablePath; InJob = $inJob }
  foreach ($child in (Get-CimInstance Win32_Process -Filter "ParentProcessId=$nextId")) { $pendingIds.Enqueue([int]$child.ProcessId) }
}
$acl = if ($DataDir) { [IO.Directory]::GetAccessControl($DataDir).GetSecurityDescriptorSddlForm('All') } else { $null }
$pipeAcl = $null
if ($PipeName) {
  $owner = $group = $dacl = $sacl = $descriptor = [IntPtr]::Zero
  $pipe = [D1Native]::CreateFile($PipeName, 0x20000, 3, [IntPtr]::Zero, 3, 0x40000000, [IntPtr]::Zero)
  if ($pipe -eq [IntPtr](-1)) { throw "Cannot open own pipe security: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
  $errorCode = [D1Native]::GetSecurityInfo($pipe, 6, 4, [ref]$owner, [ref]$group, [ref]$dacl, [ref]$sacl, [ref]$descriptor)
  [D1Native]::CloseHandle($pipe) | Out-Null
  if ($errorCode -ne 0) { throw "Cannot inspect own pipe security: $errorCode" }
  try {
    $text = [IntPtr]::Zero; $length = [uint32]0
    if (![D1Native]::ConvertSecurityDescriptorToStringSecurityDescriptor($descriptor, 1, 4, [ref]$text, [ref]$length)) { throw 'Cannot read pipe SDDL' }
    try { $pipeAcl = [Runtime.InteropServices.Marshal]::PtrToStringUni($text) }
    finally { [D1Native]::LocalFree($text) | Out-Null }
  } finally { [D1Native]::LocalFree($descriptor) | Out-Null }
}
@{ processes = @($processes.Values | Sort-Object ProcessId); dataDirSddl = $acl; pipeSddl = $pipeAcl } | ConvertTo-Json -Depth 5 -Compress
