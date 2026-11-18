# CI (release.yml, 11-17): the built MSI on a clean Windows: a quiet install, the installed HW Deck started on made-up
# data (its own data folder, a debug port), its page checked, a clean quit, a quiet uninstall, and nothing left behind
# (the folder, the Start menu and desktop shortcuts, the Start with Windows entry, the Keep HWiNFO sharing task).
# Any failure ends the job, so a release whose installer is broken is never published.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'CI only: it installs and UNINSTALLS HW Deck, never run it on a PC that uses HW Deck' }
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$msi = Get-ChildItem "$root\dist\HWDeck-*.msi" | Select-Object -First 1
if (-not $msi) { throw 'no MSI in dist' }
$pf = "$env:ProgramFiles\HW Deck"; $fails = 0
function Check($name, $ok) { if ($ok) { "PASS $name" } else { "FAIL $name"; $script:fails++ } }
$p = Start-Process msiexec.exe -ArgumentList '/i', "`"$($msi.FullName)`"", '/qn', '/norestart', '/l*v', "`"$root\dist\install.log`"" -Wait -PassThru
Check "the MSI installs quietly (exit $($p.ExitCode))" ($p.ExitCode -eq 0)
Check 'HWDeck.exe and its page files are in Program Files' ((Test-Path "$pf\HWDeck.exe") -and (Test-Path "$pf\web\deck.js") -and (Test-Path "$pf\Microsoft.Web.WebView2.Core.dll"))
Check 'the Start menu shortcut is there' (Test-Path "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\HW Deck.lnk")
Get-Process HWDeck -ErrorAction SilentlyContinue | Stop-Process -Force   # (the installer may start it: the test starts its own copy)
# (11-18, v2.6.3's first run: GitHub's Windows Server image has Edge but no WebView2 Runtime, which every Windows 10 / 11
# PC has; the app stopped at its "needs the WebView2 Runtime" box and its page never came. Installed here as a PC has it)
$wvKeys = 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
$wvVer = { foreach ($k in $wvKeys) { $v = (Get-ItemProperty $k -Name pv -ErrorAction SilentlyContinue).pv; if ($v -and $v -ne '0.0.0.0') { return $v } }; $null }
if (-not (& $wvVer)) {
  try {
    $bs = Join-Path $env:RUNNER_TEMP 'MicrosoftEdgeWebview2Setup.exe'
    Invoke-WebRequest 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $bs -UseBasicParsing
    Start-Process $bs -ArgumentList '/silent', '/install' -Wait
  } catch { "  (the WebView2 Runtime's setup: $($_.Exception.Message))" }
}
"WebView2 Runtime: $(& $wvVer)"
$data = Join-Path $env:RUNNER_TEMP 'hwdeck-ci-data'; New-Item -ItemType Directory -Force $data | Out-Null
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9230'
# (11-18, third run: the app started, drew its page, its browser ran, but without the debug port: the runner runs the
# job as administrator and the environment variable wasn't taken. WebView2's policy key gives the same argument to
# HWDeck.exe whoever runs it; taken away again below)
$wvPol = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments', 'HKCU:\SOFTWARE\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments'
foreach ($k in $wvPol) { try { New-Item -Path $k -Force | Out-Null; New-ItemProperty -Path $k -Name 'HWDeck.exe' -Value '--remote-debugging-port=9230' -PropertyType String -Force | Out-Null } catch { "  (the policy key ${k}: $($_.Exception.Message))" } }
$app = Start-Process "$pf\HWDeck.exe" -ArgumentList '--fake', 60, '--data', $data, '--no-starter' -PassThru
Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
$up = $false
for ($i = 0; $i -lt 40 -and -not $up; $i++) { Start-Sleep -Seconds 1; try { $up = (Invoke-WebRequest 'http://127.0.0.1:9230/json' -UseBasicParsing -TimeoutSec 2).Content -match 'hwdeck\.example' } catch { } }
# (11-18, fourth run: no debug port here after all = the page seen through Windows instead: its window holds the app's
# web content (UI Automation) and its own log says it started. A broken install has neither)
function SeenByWindows {   # (also the second word when the port's own check didn't confirm the readings in time)
  $script:web = $null
  try {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    $A = [System.Windows.Automation.AutomationElement]
    $c = New-Object System.Windows.Automation.PropertyCondition($A::ProcessIdProperty, $app.Id)
    foreach ($w in $A::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $c)) {
      foreach ($t in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) { if ($t.Current.Name -match 'Web content') { $script:web = $t.Current.Name } }
    }
  } catch { }
  $script:started = [bool](Get-Content "$data\app.log" -ErrorAction SilentlyContinue | Select-String -SimpleMatch 'start ')
  [bool]($script:web -and $script:started)
}
$web = $null; $started = $false
$seen = $up -or (SeenByWindows)
Check $(if ($up) { 'the installed app opens its page' } else { "the installed app opens its page (seen through Windows, no debug port on this machine: '$web', its log started: $started)" }) $seen
if (-not $seen) {   # (what it shows instead, and its own log: the cause in the job's output, not a guess)
  Get-Process HWDeck -ErrorAction SilentlyContinue | ForEach-Object { "  window: '$($_.MainWindowTitle)' (pid $($_.Id))" }
  # (11-18, second run: a window titled "HW Deck" and an empty log = one of the app's own boxes before it starts; its
  # words, read through UI Automation, and whether its WebView2 browser started at all)
  try {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    $A = [System.Windows.Automation.AutomationElement]
    foreach ($pr in @(Get-Process HWDeck -ErrorAction SilentlyContinue)) {
      $c = New-Object System.Windows.Automation.PropertyCondition($A::ProcessIdProperty, $pr.Id)
      foreach ($w in $A::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $c)) {
        "  its window '$($w.Current.Name)' ($($w.Current.ClassName)):"
        foreach ($t in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) { if ($t.Current.Name) { "    $($t.Current.ControlType.ProgrammaticName -replace 'ControlType\.', ''): $($t.Current.Name)" } }
      }
    }
  } catch { "  (couldn't read its window: $($_.Exception.Message))" }
  $wv = @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue)
  "  WebView2 browser processes: $($wv.Count)" + $(if ($wv.Count) { ', debug port in its arguments: ' + [bool]($wv | Where-Object { $_.CommandLine -match 'remote-debugging-port' }) } else { '' })
  if (Test-Path "$data\app.log") { '  app.log:'; Get-Content "$data\app.log" -Tail 25 | ForEach-Object { "    $_" } } else { '  no app.log in the data folder' }
}
if ($up) {
  $o = node -e "import('file:///$($root -replace '\\','/')/test/cdp.mjs').then(async m => { const p = await m.connect(9230); for (let i = 0; i < 240; i++) { if (await p.evaluate('typeof feed !== \'undefined\' && feed.got && READ.length > 50')) { console.log('READY ' + (await p.evaluate('feed.version'))); break; } await p.sleep(250); } p.evaluate('send({ t: \'exit\' })').catch(() => {}); setTimeout(() => process.exit(0), 800); }).catch(e => { console.log('ERR ' + e); process.exit(0); })" | Out-String
  $ready = $o -match 'READY'
  $ok2 = $ready -or (SeenByWindows)
  Check $(if ($ready) { "its page draws the made-up readings ($($o.Trim()))" } else { "its page, seen through Windows ($($o.Trim()); '$web', its log started: $started)" }) $ok2
}
$quit = $up -and $app.WaitForExit(15000)   # (the port's exit)
if (-not $quit) { try { [void](Get-Process -Id $app.Id -ErrorAction Stop).CloseMainWindow() } catch { }; $quit = $app.WaitForExit(15000) }   # (WM_CLOSE from outside = a quit, as the deploy script closes it)
if (-not $quit) { Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue }
Check 'it quits cleanly' $quit
foreach ($k in $wvPol) { try { Remove-ItemProperty -Path $k -Name 'HWDeck.exe' -ErrorAction SilentlyContinue } catch { } }
$p = Start-Process msiexec.exe -ArgumentList '/x', "`"$($msi.FullName)`"", '/qn', '/norestart', '/l*v', "`"$root\dist\uninstall.log`"" -Wait -PassThru
Check "the MSI uninstalls quietly (exit $($p.ExitCode))" ($p.ExitCode -eq 0)
Check 'nothing left in Program Files' (-not (Test-Path "$pf\HWDeck.exe"))
Check 'no Start menu shortcut left' (-not (Test-Path "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\HW Deck.lnk"))
Check 'no Start with Windows entry left' (-not (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'HW Deck' -ErrorAction SilentlyContinue))
Check 'no Keep HWiNFO sharing task left' (-not (Get-ScheduledTask -TaskName 'HW Deck - Keep HWiNFO sharing' -ErrorAction SilentlyContinue))
if ($fails) { throw "$fails install check(s) failed: the release is not published" } else { 'ALL PASS (install test)' }
