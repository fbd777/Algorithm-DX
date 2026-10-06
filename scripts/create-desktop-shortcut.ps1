param(
  [string]$DesktopDirectory = [Environment]::GetFolderPath('Desktop'),
  [string]$ShortcutName = 'Algorithm DX'
)
$ErrorActionPreference = 'Stop'
$projectDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$launcher = Join-Path $projectDirectory 'dashboard.cmd'
$icon = Join-Path $projectDirectory 'public\algorithm-dx-mark.ico'
if (!(Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'dashboard.cmd is missing. Keep this script inside the project scripts folder.' }
if (!(Test-Path -LiteralPath $icon -PathType Leaf)) { throw 'The project icon is missing. Download the complete project.' }
if (!(Test-Path -LiteralPath $DesktopDirectory -PathType Container)) { throw 'Desktop folder was not found.' }
if ([string]::IsNullOrWhiteSpace($ShortcutName) -or $ShortcutName.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0 -or $ShortcutName.EndsWith('.') -or $ShortcutName.EndsWith(' ')) {
  throw 'ShortcutName must be a valid file name without a path.'
}
$shortcut = Join-Path ([IO.Path]::GetFullPath($DesktopDirectory)) ($ShortcutName + '.lnk')
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($shortcut)
if ((Test-Path -LiteralPath $shortcut) -and $link.TargetPath -and ![string]::Equals($link.TargetPath,$launcher,[StringComparison]::OrdinalIgnoreCase)) {
  throw 'An Algorithm DX shortcut for another location already exists. Rename or remove that shortcut before continuing.'
}
$link.TargetPath = $launcher
$link.Arguments = ''
$link.WorkingDirectory = $projectDirectory
$link.IconLocation = "$icon,0"
$link.Description = 'Launch Algorithm DX dashboard'
$link.Save()
$saved = $shell.CreateShortcut($shortcut)
if (![string]::Equals($saved.TargetPath, $launcher, [StringComparison]::OrdinalIgnoreCase) -or ![string]::Equals($saved.WorkingDirectory, $projectDirectory, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Shortcut verification failed. Check that the desktop folder is writable.'
}
Add-Type 'using System; using System.Runtime.InteropServices; public class AlgorithmDXShortcutRefresh { [DllImport("shell32.dll")] public static extern void SHChangeNotify(uint e,uint f,IntPtr a,IntPtr b); }' -ErrorAction SilentlyContinue
[AlgorithmDXShortcutRefresh]::SHChangeNotify(0x08000000,0,[IntPtr]::Zero,[IntPtr]::Zero)
Write-Output "Shortcut ready: $shortcut"
