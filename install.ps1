# Installs (or updates) HW Deck: downloads the newest HWDeck-x.y.z.msi from GitHub Releases, checks it against the
# release's SHA256SUMS.txt, then runs it. Paste into PowerShell:
#   irm https://raw.githubusercontent.com/RodrigoArsenioo/hwdeck/main/install.ps1 | iex
# (A file PowerShell downloads isn't marked as a browser download, so Windows doesn't ask about it again. Writing to
# Program Files takes one Windows permission prompt, as with any installer: on an admin account this starts Windows
# Installer itself with admin rights, so that prompt comes first and names Windows Installer and its publisher,
# Microsoft, with the file it installs under "Show more details". Then the installer's own pages, as always: the
# folder, the shortcuts, and HW Deck opened from the last one, without admin rights. On any other account the
# installer asks for an admin itself, when its pages are done.)
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
    $me = [Security.Principal.WindowsIdentity]::GetCurrent()
    $adminAccount = [bool]($me.Claims | Where-Object { $_.Value -eq 'S-1-5-32-544' })   # (in the Administrators group, whether or not this PowerShell runs as admin)
    # (with Windows 11's Administrator protection, "as admin" runs as an admin account Windows keeps for that, not as
    # this one: the installer is then started as this account, as on any other, so what it sets up is this account's)
    if ((Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -ErrorAction SilentlyContinue).TypeOfAdminApprovalMode -eq 2) { $adminAccount = $false }
    # (an installer older than 2.4.5 opens HW Deck straight from its last page: started as admin, it would open HW Deck
    # as admin too, so that one is started as before)
    $ver = $null
    if (-not [version]::TryParse(($name -replace '^HWDeck-|\.msi$'), [ref]$ver) -or $ver -lt [version]'2.4.5') { $adminAccount = $false }
    # wait for the installer only (-Wait would also wait for HW Deck if its last page starts it)
    if ($adminAccount) {
      try { $p = Start-Process msiexec.exe -ArgumentList '/i', "`"$file`"" -Verb RunAs -PassThru }
      catch {
        $e = $_.Exception; while ($e -and $e -isnot [ComponentModel.Win32Exception]) { $e = $e.InnerException }
        if ($e -and $e.NativeErrorCode -eq 1223) { Write-Host 'Installation cancelled.'; return }   # (No in the Windows prompt)
        throw
      }
    }
    else { $p = Start-Process msiexec.exe -ArgumentList '/i', "`"$file`"" -PassThru }
    $null = $p.Handle; $p.WaitForExit()
    if (0, 1641, 3010 -contains $p.ExitCode) { Write-Host 'HW Deck is installed. Start it from the Start menu.' -ForegroundColor Green }
    elseif ($p.ExitCode -eq 1602) { Write-Host 'Installation cancelled.' }
    else { Write-Host "The installer stopped with code $($p.ExitCode)." -ForegroundColor Red }
  }
  catch { Write-Host "Couldn't install HW Deck: $($_.Exception.Message)" -ForegroundColor Red }
  finally { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
}
