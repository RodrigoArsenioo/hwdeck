# downloads the WebView2 SDK assemblies (not committed): WinForms + Core + the native loader, from nuget, at the
# version HW Deck is built and tested with (checked against its hash). Run once before scripts\build.ps1 on a fresh clone.
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ver = "1.0.4078.44"
$sha = "DC4D1D9168DF26B830398303E50210B6E1729F6CE5A7AC69D2C766852F489962"
$tmp = Join-Path $env:TEMP "hwdeck-wv2"
Invoke-WebRequest -Uri "https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/$ver" -OutFile "$tmp.zip" -UseBasicParsing
if ((Get-FileHash "$tmp.zip" -Algorithm SHA256).Hash -ne $sha) { Remove-Item "$tmp.zip"; throw "the downloaded package doesn't match the expected hash" }
Expand-Archive "$tmp.zip" $tmp -Force
Copy-Item "$tmp\lib\net462\Microsoft.Web.WebView2.WinForms.dll" $dir -Force
Copy-Item "$tmp\lib\net462\Microsoft.Web.WebView2.Core.dll" $dir -Force
Copy-Item "$tmp\runtimes\win-x64\native\WebView2Loader.dll" $dir -Force
Remove-Item "$tmp.zip", $tmp -Recurse -Force
"deps ready ($ver):"
Get-ChildItem $dir -Filter *.dll -Name
