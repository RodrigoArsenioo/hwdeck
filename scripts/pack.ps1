# builds HWDeck.exe and puts everything a PC needs into dist\HWDeck-<version>.zip (unzip anywhere, run HWDeck.exe),
# plus dist\SHA256SUMS.txt
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
& "$dir\scripts\build.ps1"
if ($LASTEXITCODE -ne 0) { exit 1 }
$ver = (Select-String -Path "$dir\src\app.cs" -Pattern 'Version = "([^"]+)"').Matches[0].Groups[1].Value
$files = @{
  'HWDeck.exe' = "$dir\HWDeck.exe"; 'app.ico' = "$dir\src\app.ico"; 'LICENSE' = "$dir\LICENSE"
  'Microsoft.Web.WebView2.Core.dll' = "$dir\Microsoft.Web.WebView2.Core.dll"
  'Microsoft.Web.WebView2.WinForms.dll' = "$dir\Microsoft.Web.WebView2.WinForms.dll"
  'WebView2Loader.dll' = "$dir\WebView2Loader.dll"
  'README.txt' = "$dir\package\README.txt"; 'THIRD-PARTY-NOTICES.txt' = "$dir\package\THIRD-PARTY-NOTICES.txt"
}
New-Item -ItemType Directory "$dir\dist" -Force | Out-Null
$name = "HWDeck-$ver.zip"
$zip = "$dir\dist\$name"
if (Test-Path $zip) { Remove-Item $zip }
# entry names with forward slashes (the zip format's own; Compress-Archive in Windows PowerShell writes backslashes)
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$z = [System.IO.Compression.ZipFile]::Open($zip, 'Create')
try {
  foreach ($f in $files.Keys | Sort-Object) { [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($z, $files[$f], "HW Deck/$f", 'Optimal') }
  foreach ($f in Get-ChildItem "$dir\web" -File) { [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($z, $f.FullName, "HW Deck/web/$($f.Name)", 'Optimal') }
}
finally { $z.Dispose() }
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
[IO.File]::WriteAllText("$dir\dist\SHA256SUMS.txt", "$hash  $name`n")
"packed: $zip ({0:N0} KB)" -f ((Get-Item $zip).Length / 1KB)
"sha256: $hash"
