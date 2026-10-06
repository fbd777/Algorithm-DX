param([string]$DesktopDirectory = [Environment]::GetFolderPath('Desktop'))
$ErrorActionPreference = 'Stop'
$projectDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$launcher = Join-Path $projectDirectory 'dashboard.cmd'
$icon = Join-Path $projectDirectory 'public\algorithm-dx-mark.ico'
if (!(Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'dashboard.cmd is missing. Keep this script inside the project scripts folder.' }
if (!(Test-Path -LiteralPath $icon -PathType Leaf)) { throw 'The project icon is missing. Download the complete project.' }
if (!(Test-Path -LiteralPath $DesktopDirectory -PathType Container)) { throw 'Desktop folder was not found.' }
$shortcut = Join-Path $DesktopDirectory 'Algorithm DX.lnk'
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($shortcut)
if ((Test-Path -LiteralPath $shortcut) -and $link.TargetPath -and ![string]::Equals($link.TargetPath,$launcher,[StringComparison]::OrdinalIgnoreCase)) {
  throw 'An Algorithm DX shortcut for another location already exists. Rename or remove that shortcut before continuing.'
}
$link.TargetPath = $launcher
$link.WorkingDirectory = $projectDirectory
$link.IconLocation = "$icon,0"
$link.Description = 'Launch Algorithm DX dashboard'
$link.Save()
Add-Type 'using System; using System.Runtime.InteropServices; public class AlgorithmDXShortcutRefresh { [DllImport("shell32.dll")] public static extern void SHChangeNotify(uint e,uint f,IntPtr a,IntPtr b); }' -ErrorAction SilentlyContinue
[AlgorithmDXShortcutRefresh]::SHChangeNotify(0x08000000,0,[IntPtr]::Zero,[IntPtr]::Zero)
Write-Output "Shortcut ready: $shortcut"
