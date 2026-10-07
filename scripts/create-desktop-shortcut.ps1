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
# WScript.Shell can reject paths outside the Windows ANSI code page. Use the
# Unicode Shell Link interface so downloaded folders work in every system locale.
if (-not ('AlgorithmDXShortcut' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

[ComImport, Guid("00021401-0000-0000-C000-000000000046")]
internal class AlgorithmDXShellLink { }

[ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface AlgorithmDXShellLinkW {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int count, IntPtr data, uint flags);
    void GetIDList(out IntPtr idList);
    void SetIDList(IntPtr idList);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int count);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string value);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int count);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string value);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int count);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string value);
    void GetHotkey(out short value);
    void SetHotkey(short value);
    void GetShowCmd(out int value);
    void SetShowCmd(int value);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int count, out int index);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string path, int index);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
    void Resolve(IntPtr window, uint flags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
}

public static class AlgorithmDXShortcut {
    public static string[] Read(string path) {
        var link = (AlgorithmDXShellLinkW)new AlgorithmDXShellLink();
        try {
            ((IPersistFile)link).Load(path, 0);
            var target = new StringBuilder(32768);
            var directory = new StringBuilder(32768);
            var arguments = new StringBuilder(32768);
            link.GetPath(target, target.Capacity, IntPtr.Zero, 4);
            link.GetWorkingDirectory(directory, directory.Capacity);
            link.GetArguments(arguments, arguments.Capacity);
            return new [] { target.ToString(), directory.ToString(), arguments.ToString() };
        } finally { Marshal.FinalReleaseComObject(link); }
    }
    public static void Write(string path, string target, string directory, string icon) {
        var link = (AlgorithmDXShellLinkW)new AlgorithmDXShellLink();
        try {
            link.SetPath(target);
            link.SetArguments("");
            link.SetWorkingDirectory(directory);
            link.SetIconLocation(icon, 0);
            link.SetDescription("Launch Algorithm DX dashboard");
            ((IPersistFile)link).Save(path, true);
        } finally { Marshal.FinalReleaseComObject(link); }
    }
    [DllImport("shell32.dll")]
    public static extern void SHChangeNotify(uint e, uint f, IntPtr a, IntPtr b);
}
"@
}
if (Test-Path -LiteralPath $shortcut) {
  $existing = [AlgorithmDXShortcut]::Read($shortcut)
  if ($existing[0] -and ![string]::Equals($existing[0], $launcher, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'An Algorithm DX shortcut for another location already exists. Rename or remove that shortcut before continuing.'
  }
}
[AlgorithmDXShortcut]::Write($shortcut, $launcher, $projectDirectory, $icon)
$saved = [AlgorithmDXShortcut]::Read($shortcut)
if (![string]::Equals($saved[0], $launcher, [StringComparison]::OrdinalIgnoreCase) -or ![string]::Equals($saved[1], $projectDirectory, [StringComparison]::OrdinalIgnoreCase) -or $saved[2] -ne '') {
  throw 'Shortcut verification failed. Check that the desktop folder is writable.'
}
[AlgorithmDXShortcut]::SHChangeNotify(0x08000000,0,[IntPtr]::Zero,[IntPtr]::Zero)
Write-Output "Shortcut ready: $shortcut"
