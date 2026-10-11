# builds HWDeck.exe from src\app.cs with the .NET Framework compiler that comes with Windows
# (run scripts\fetch-deps.ps1 once first on a fresh clone)
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$out = if ($args.Count -gt 0) { $args[0] } else { "$dir\HWDeck.exe" }
$csc = "$env:SystemRoot\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
& $csc /nologo /target:winexe /platform:x64 /optimize+ `
    /out:"$out" `
    /win32icon:"$dir\src\app.ico" `
    /win32manifest:"$dir\src\app.manifest" `
    /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll `
    /r:"$dir\Microsoft.Web.WebView2.WinForms.dll" `
    /r:"$dir\Microsoft.Web.WebView2.Core.dll" `
    "$dir\src\app.cs"
if ($LASTEXITCODE -ne 0) { "BUILD FAILED"; exit 1 }
# the window and tray icon are read from app.ico next to the exe
Copy-Item "$dir\src\app.ico" (Join-Path (Split-Path -Parent $out) 'app.ico') -Force
"built: $out"
