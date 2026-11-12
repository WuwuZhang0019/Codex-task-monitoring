# 日期：2026-11-12。只读原生状态；无输入注入、窗口移动或UIAutomation调用。
param([long]$IslandHandle=0,[long]$SettingsHandle=0)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class EReadOnlyWindowState {
 [StructLayout(LayoutKind.Sequential)] public struct RECT {public int Left;public int Top;public int Right;public int Bottom;}
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd,out RECT rect);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
 [StructLayout(LayoutKind.Sequential)] public struct POINT {public int X;public int Y;}
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 [DllImport("user32.dll")] public static extern bool GetPhysicalCursorPos(out POINT point);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
 [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
 [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
 [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd,uint flags);
 [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hwnd,int index);
}
"@
function Owner($handle) {
 [uint32]$windowPid=0
 [void][EReadOnlyWindowState]::GetWindowThreadProcessId($handle,[ref]$windowPid)
 $p=Get-Process -Id $windowPid -ErrorAction SilentlyContinue
 [ordered]@{handle=$handle.ToInt64();pid=$windowPid;process=$p.ProcessName;isEInstalled=($p.Path -eq 'G:\rust\Codex-task-monitoring\app\test-results\island-E\installed-shell\dynamic-island.exe')}
}
# 仅本诊断进程当前线程采用PMv2，避免GetWindowRect被DPI虚拟化；不改系统缩放或产品状态。
$priorContext=[EReadOnlyWindowState]::SetThreadDpiAwarenessContext([IntPtr](-4))
$fg=[EReadOnlyWindowState]::GetForegroundWindow()
$point=New-Object EReadOnlyWindowState+POINT
[void][EReadOnlyWindowState]::GetPhysicalCursorPos([ref]$point)
$under=[EReadOnlyWindowState]::WindowFromPoint($point)
$root=[EReadOnlyWindowState]::GetAncestor($under,2)
function Geometry([long]$value) {
 if($value -eq 0){return $null}
 $h=[IntPtr]$value
 $o=Owner $h
 if(!$o.isEInstalled){throw 'WINDOW_NOT_OWNED_BY_E_INSTALLED'}
 $r=New-Object EReadOnlyWindowState+RECT
 [void][EReadOnlyWindowState]::GetWindowRect($h,[ref]$r)
 $style=[EReadOnlyWindowState]::GetWindowLongPtr($h,-20).ToInt64()
 [ordered]@{owner=$o;rect=@{left=$r.Left;top=$r.Top;right=$r.Right;bottom=$r.Bottom};dpi=[EReadOnlyWindowState]::GetDpiForWindow($h);visible=[EReadOnlyWindowState]::IsWindowVisible($h);topmost=(($style -band 8)-ne 0);transparent=(($style -band 32)-ne 0)}
}
[ordered]@{date='2026-11-12';coordinateSpace='physical pixels; probe thread PMv2';foreground=(Owner $fg);cursor=@{x=$point.X;y=$point.Y};underCursor=(Owner $root);island=(Geometry $IslandHandle);settings=(Geometry $SettingsHandle)} | ConvertTo-Json -Depth 7 -Compress

if($priorContext -ne [IntPtr]::Zero){[void][EReadOnlyWindowState]::SetThreadDpiAwarenessContext($priorContext)}
