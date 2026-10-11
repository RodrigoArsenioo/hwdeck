# builds HWDeck.exe and puts what a PC needs into dist\: HWDeck-<version>.zip (unzip anywhere, run HWDeck.exe),
# HWDeck-<version>.msi (the installer, same files) and SHA256SUMS.txt. The MSI needs the .NET SDK (WiX comes from the
# repo's tool manifest)
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
& "$dir\scripts\build.ps1"
if ($LASTEXITCODE -ne 0) { exit 1 }
$ver = (Select-String -Path "$dir\src\app.cs" -Pattern 'Version = "([^"]+)"').Matches[0].Groups[1].Value

# the files, once: the zip and the installer both take them from here
$stage = "$dir\dist\stage"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory "$stage\web" -Force | Out-Null
Copy-Item "$dir\HWDeck.exe", "$dir\Microsoft.Web.WebView2.Core.dll", "$dir\Microsoft.Web.WebView2.WinForms.dll", "$dir\WebView2Loader.dll", "$dir\LICENSE" $stage
Copy-Item "$dir\src\app.ico", "$dir\package\README.txt", "$dir\package\THIRD-PARTY-NOTICES.txt" $stage
Copy-Item "$dir\web\*" "$stage\web"

$zip = "$dir\dist\HWDeck-$ver.zip"
if (Test-Path $zip) { Remove-Item $zip }
# entry names with forward slashes (the zip format's own; Compress-Archive in Windows PowerShell writes backslashes)
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$z = [System.IO.Compression.ZipFile]::Open($zip, 'Create')
try {
  foreach ($f in Get-ChildItem $stage -Recurse -File | Sort-Object FullName) {
    $rel = $f.FullName.Substring($stage.Length + 1).Replace('\', '/')
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($z, $f.FullName, "HW Deck/$rel", 'Optimal')
  }
}
finally { $z.Dispose() }

$msi = "$dir\dist\HWDeck-$ver.msi"
Push-Location $dir
try {
  dotnet tool restore | Out-Null
  dotnet wix extension add WixToolset.UI.wixext/5.0.2 WixToolset.Util.wixext/5.0.2 | Out-Null
  dotnet wix build installer\HWDeck.wxs -arch x64 -d "Version=$ver" -d "Stage=$stage" -ext WixToolset.UI.wixext -ext WixToolset.Util.wixext -o $msi
  if ($LASTEXITCODE -ne 0) { throw "the installer didn't build" }
}
finally { Pop-Location }
Remove-Item "$dir\dist\HWDeck-$ver.wixpdb" -ErrorAction SilentlyContinue

$sums = foreach ($f in $zip, $msi) { (Get-FileHash $f -Algorithm SHA256).Hash.ToLower() + "  " + (Split-Path $f -Leaf) }
[IO.File]::WriteAllText("$dir\dist\SHA256SUMS.txt", ($sums -join "`n") + "`n")
"packed: $zip ({0:N0} KB)" -f ((Get-Item $zip).Length / 1KB)
"packed: $msi ({0:N0} KB)" -f ((Get-Item $msi).Length / 1KB)
