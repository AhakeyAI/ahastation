import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

// Windows PowerShell 5.1 uses .NET Framework's FileStream(FileSecurity)
// constructor: the DACL is applied by CreateFile, BEFORE any bytes are written.
// All paths/data arrive via stdin JSON, never shell interpolation or argv.
const WINDOWS_SECURITY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
try {
  $inputValue = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
  function New-PrivateSecurity([bool] $directory) {
    if ($directory) { $security = [Security.AccessControl.DirectorySecurity]::new() }
    else { $security = [Security.AccessControl.FileSecurity]::new() }
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner($identity)
    foreach ($sid in @($identity, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
      if ($directory) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
      } else { $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow') }
      $security.AddAccessRule($rule)
    }
    return $security
  }
  if ($inputValue.action -in @('directory', 'file')) {
    $directory = $inputValue.action -eq 'directory'
    if ($directory -and ![IO.Directory]::Exists($inputValue.path)) {
      [void][IO.Directory]::CreateDirectory($inputValue.path, (New-PrivateSecurity $true))
    }
    if (([IO.File]::GetAttributes($inputValue.path) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse-path' }
    if ($directory) { $acl = [IO.Directory]::GetAccessControl($inputValue.path) }
    else { $acl = [IO.File]::GetAccessControl($inputValue.path) }
    if (($directory -and !$acl.AreAccessRulesProtected) -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $identity.Value) { throw 'unsafe-store-permissions' }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($identity.Value, 'S-1-5-18', 'S-1-5-32-544')) { throw 'unsafe-store-permissions' }
    }
  } elseif ($inputValue.action -eq 'stage') {
    $sections = [Security.AccessControl.AccessControlSections]'Access,Owner,Group'
    if ([IO.File]::Exists($inputValue.original)) {
      if (([IO.File]::GetAttributes($inputValue.original) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse-path' }
      $security = [IO.File]::GetAccessControl($inputValue.original, $sections)
    } else { $security = New-PrivateSecurity $false }
    $stream = [IO.FileStream]::new($inputValue.path, [IO.FileMode]::CreateNew,
      [Security.AccessControl.FileSystemRights]::FullControl, [IO.FileShare]::None,
      4096, [IO.FileOptions]::WriteThrough, $security)
    try {
      $actual = [IO.File]::GetAccessControl($inputValue.path, $sections)
      function Dacl-Bytes($value) {
        $raw = [Security.AccessControl.RawSecurityDescriptor]::new($value.GetSecurityDescriptorBinaryForm(), 0)
        if ($null -eq $raw.DiscretionaryAcl) { throw 'null-dacl' }
        $bytes = [byte[]]::new($raw.DiscretionaryAcl.BinaryLength)
        $raw.DiscretionaryAcl.GetBinaryForm($bytes, 0)
        return [Convert]::ToBase64String($bytes)
      }
      # The informational AUTO_INHERITED bit can differ at creation. Access
      # rules (including inherited ACE flags), protection, owner and group
      # must remain the same; never write content after a failed comparison.
      if ($security.AreAccessRulesProtected -ne $actual.AreAccessRulesProtected -or
        (Dacl-Bytes $security) -ne (Dacl-Bytes $actual) -or
        $security.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value) { throw 'security-not-preserved' }
      $group = $security.GetGroup([Security.Principal.SecurityIdentifier])
      if ($null -ne $group -and $group.Value -ne $actual.GetGroup([Security.Principal.SecurityIdentifier]).Value) { throw 'security-not-preserved' }
      $bytes = [Convert]::FromBase64String($inputValue.data)
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Flush($true)
    } finally { $stream.Dispose() }
  } else { throw 'unsupported-action' }
} catch { [Environment]::Exit(1) }
`;

function windowsSecurity(input: Record<string, string>): void {
  const root = process.env.SystemRoot;
  if (!root || !isAbsolute(root)) throw new Error('windows-file-security-unavailable');
  try {
    execFileSync(join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_SECURITY_SCRIPT, 'utf16le').toString('base64')],
      { input: JSON.stringify(input), encoding: 'utf8', timeout: 15_000,
        windowsHide: true, maxBuffer: 64 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch { throw new Error('windows-file-security-failed'); } // no path/config/stderr dump
}

/** App-owned store only. An existing unsafe directory is refused, never
 * silently chmodded or stripped of someone else's ACL. */
export function ensurePrivateHookDirectory(path: string): void {
  if (!isAbsolute(path)) throw new Error('absolute-private-directory-required');
  for (let p = resolve(path); ; p = dirname(p)) {
    if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new Error('symlink-private-directory');
    if (p === dirname(p)) break;
  }
  if (process.platform === 'win32') windowsSecurity({ action: 'directory', path });
  else {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const stat = lstatSync(path);
    if (!stat.isDirectory() || (stat.mode & 0o077) !== 0
      || (process.getuid && stat.uid !== process.getuid())) throw new Error('unsafe-private-directory');
  }
}

export function stageWindowsConfig(temp: string, original: string, content: string): void {
  windowsSecurity({ action: 'stage', path: temp, original, data: Buffer.from(content, 'utf8').toString('base64') });
}

/** Existing descendants can have explicit ACLs wider than their parent. */
export function assertPrivateHookFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe-private-file');
  if (process.platform === 'win32') windowsSecurity({ action: 'file', path });
  else if ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error('unsafe-private-file');
  }
}
