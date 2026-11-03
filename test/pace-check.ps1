# The bottleneck's pace test and call on their own (test\pace-check.cs): built with the app's code as a console program
# in test\out, then run. No window, no HWiNFO, a few seconds.
#   powershell -File test\pace-check.ps1
$d = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$out = "$d\test\out\pace-check.exe"
New-Item -ItemType Directory -Force "$d\test\out" | Out-Null
$csc = "$env:SystemRoot\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
& $csc /nologo /target:exe /platform:x64 /optimize+ /main:PaceCheck /out:"$out" `
    /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll `
    /r:"$d\Microsoft.Web.WebView2.WinForms.dll" /r:"$d\Microsoft.Web.WebView2.Core.dll" `
    "$d\src\app.cs" "$d\test\pace-check.cs"
if ($LASTEXITCODE -ne 0) { "BUILD FAILED"; exit 1 }
Copy-Item "$d\Microsoft.Web.WebView2.Core.dll", "$d\Microsoft.Web.WebView2.WinForms.dll" "$d\test\out" -Force
& $out
exit $LASTEXITCODE
