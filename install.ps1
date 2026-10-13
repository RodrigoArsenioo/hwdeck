# Installs (or updates) HW Deck: downloads the newest HWDeck-x.y.z.msi from GitHub Releases, checks it against the
# release's SHA256SUMS.txt, then runs it. Paste into PowerShell:
#   irm https://raw.githubusercontent.com/RodrigoArsenioo/hwdeck/main/install.ps1 | iex
# (A file PowerShell downloads isn't marked as a browser download, so Windows doesn't ask about it again; the
# installer itself still asks for permission to write to Program Files, as installers do.)
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'   # (the progress bar makes downloads in Windows PowerShell much slower)
  # the newest release's files, straight from GitHub's "latest" links (no API call, so no hourly limit)
  $base = 'https://github.com/RodrigoArsenioo/hwdeck/releases/latest/download/'
  $dir = Join-Path $env:TEMP ('hwdeck-install-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $dir | Out-Null
  try {
    $sums = Join-Path $dir 'SHA256SUMS.txt'
    Invoke-WebRequest ($base + 'SHA256SUMS.txt') -OutFile $sums -UseBasicParsing
    $line = Get-Content $sums | Where-Object { ($_ -split '\s+')[-1] -match '^HWDeck-[\d.]+\.msi$' } | Select-Object -First 1
    if (-not $line) { Write-Host "Couldn't find the installer in the latest release." -ForegroundColor Red; return }
    $want, $name = ($line -split '\s+')[0], ($line -split '\s+')[-1]
    $file = Join-Path $dir $name
    Write-Host "Downloading $name..."
    Invoke-WebRequest ($base + $name) -OutFile $file -UseBasicParsing
    if ((Get-FileHash $file -Algorithm SHA256).Hash -ne $want) { Write-Host "The download doesn't match its published checksum, so it isn't installed." -ForegroundColor Red; return }
    Write-Host 'Checksum ok. Starting the installer...'
    # wait for the installer only (-Wait would also wait for HW Deck if its last page starts it)
    $p = Start-Process msiexec.exe -ArgumentList '/i', "`"$file`"" -PassThru
    $null = $p.Handle; $p.WaitForExit()
    if (0, 1641, 3010 -contains $p.ExitCode) { Write-Host 'HW Deck is installed. Start it from the Start menu.' -ForegroundColor Green }
    elseif ($p.ExitCode -eq 1602) { Write-Host 'Installation cancelled.' }
    else { Write-Host "The installer stopped with code $($p.ExitCode)." -ForegroundColor Red }
  }
  catch { Write-Host "Couldn't install HW Deck: $($_.Exception.Message)" -ForegroundColor Red }
  finally { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
}
