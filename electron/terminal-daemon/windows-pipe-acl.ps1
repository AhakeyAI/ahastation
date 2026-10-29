param([Parameter(Mandatory=$true)][string]$PipeName)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class TerminalPipeAcl {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text, uint revision, out IntPtr descriptor, out uint length);
  [DllImport("advapi32.dll", SetLastError=true)] public static extern bool GetSecurityDescriptorDacl(IntPtr descriptor, out bool present, out IntPtr dacl, out bool defaulted);
  [DllImport("advapi32.dll")] public static extern uint SetSecurityInfo(IntPtr handle, int type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
  [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr pointer);
}
'@
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$descriptor = [IntPtr]::Zero; $length = [uint32]0
if (![TerminalPipeAcl]::ConvertStringSecurityDescriptorToSecurityDescriptor("D:P(A;;GA;;;$sid)", 1, [ref]$descriptor, [ref]$length)) { throw 'Cannot build pipe ACL' }
$pipe = [IntPtr](-1)
try {
  $present = $defaulted = $false; $dacl = [IntPtr]::Zero
  if (![TerminalPipeAcl]::GetSecurityDescriptorDacl($descriptor, [ref]$present, [ref]$dacl, [ref]$defaulted)) { throw 'Cannot read pipe ACL' }
  $pipe = [TerminalPipeAcl]::CreateFile($PipeName, 0x60000, 3, [IntPtr]::Zero, 3, 0x40000000, [IntPtr]::Zero)
  if ($pipe -eq [IntPtr](-1)) { throw "Cannot open own pipe: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
  $result = [TerminalPipeAcl]::SetSecurityInfo($pipe, 6, [uint32]2147483652, [IntPtr]::Zero, [IntPtr]::Zero, $dacl, [IntPtr]::Zero)
  if ($result -ne 0) { throw "Cannot restrict own pipe ACL: $result" }
} finally {
  if ($pipe -ne [IntPtr](-1)) { [TerminalPipeAcl]::CloseHandle($pipe) | Out-Null }
  [TerminalPipeAcl]::LocalFree($descriptor) | Out-Null
}
