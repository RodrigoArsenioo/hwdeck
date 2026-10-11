# Runs every check on made-up data: the end-to-end test, a clean restart, the restart test, the scale test, the
# release checks (a prepared data folder), an unreadable working view, a restart that has to wait, sleep and the
# end of a Windows session, a held history file, the bottleneck with a made-up game, the game sessions popup and report,
# the layouts, the tile looks, and a window left open for a few minutes. Uses its own data folders under test\ and debug ports 9230-9239; the real
# HW Deck (if running) is left alone.
#   powershell -File test\run-all.ps1
$d = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $d
$failed = 0
# test windows sit behind other windows: keep Chromium from treating a covered window as hidden (it would slow its
# timers and stop its frames)
$awake = '--disable-features=CalculateNativeWinOcclusion --disable-renderer-backgrounding --disable-background-timer-throttling'
Add-Type -Namespace HWDeckTest -Name Win -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);'
function Start-Deck([string]$data, [int]$port, [int]$fake) {
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$port $awake"
  $p = Start-Process "$d\HWDeck.exe" -ArgumentList '--fake', $fake, '--data', "$d\test\$data" -WorkingDirectory $d -PassThru
  Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
  # it opens on the screen under the mouse: move it to the main screen (same size, no focus) and behind every other
  # window, so it doesn't cover anything. Leave the test windows alone while they run: a minimized or tray window gets
  # no data and its checks fail
  for ($i = 0; $i -lt 20 -and $p.MainWindowHandle -eq 0; $i++) { Start-Sleep -Milliseconds 250; $p.Refresh() }
  if ($p.MainWindowHandle -ne 0) { [void][HWDeckTest.Win]::SetWindowPos($p.MainWindowHandle, [IntPtr]1, 40, 40, 0, 0, 0x11) }
  Start-Sleep -Seconds 5
  return $p
}
function Quit-Deck($p, [int]$port) {
  # a clean quit through the page, so history and logs get written (nothing to do if the test quit it); killed if it hangs
  node -e "import('./test/cdp.mjs').then(async m => { const p = await m.connect($port); p.evaluate('send({ t: \'exit\' })').catch(() => {}); setTimeout(() => process.exit(0), 500); }).catch(() => {})" | Out-Null
  if (-not $p.WaitForExit(8000)) { Stop-Process -Id $p.Id -Force }
}
function Run([string]$name, [string]$script, [int]$port, [string]$data) {
  "== $name"
  $out = node $script $port $data
  $out
  if (-not ($out -match 'ALL PASS')) { $script:failed++ }
}
foreach ($f in 'data1', 'data3k', 'data-h', 'data-bad') { if (Test-Path "$d\test\$f") { Remove-Item -Recurse -Force -LiteralPath "$d\test\$f" } }

$p = Start-Deck 'data1' 9230 300
Run 'e2e' test/e2e.mjs 9230 test/data1
Quit-Deck $p 9230
$p = Start-Deck 'data1' 9230 300
Run 'restart' test/e2e-restart.mjs 9230 test/data1
Quit-Deck $p 9230
$p = Start-Deck 'data3k' 9231 3000
Run 'stress' test/stress.mjs 9231 ''
Quit-Deck $p 9231

# release checks: a fan cell that can't meet its curve, a cell with empty lines, a game session left open an hour ago
New-Item -ItemType Directory "$d\test\data-h" | Out-Null
$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$last = $now - 3000
Set-Content -Encoding UTF8 "$d\test\data-h\prep.json" ('{"last":' + $last + '}')
Set-Content -Encoding UTF8 "$d\test\data-h\state.json" '{"v":1,"L":{"v":1,"cats":[{"id":"ch","name":"Checks","collapsed":false,"cells":["fan1","t1"]}],"cells":{"fan1":{"key":"f0000501.0/03000002","name":"Rear fan","graph":true,"curve":{"src":"f0000501.0/01000000","pts":[[0,9000],[100,9000]],"tol":15,"hold":1}},"t1":{"key":"f0000501.0/01000000","graph":true,"gates":{"mode":"yr","dir":"above","y":null,"r":null,"hold":0}}}},"active":null,"edit":true,"screen":"tiles"}'
Set-Content -Encoding UTF8 "$d\test\data-h\games.current.json" ('{"Start":' + ($now - 3600) + ',"From":' + ($now - 3600) + ',"Last":' + $last + ',"Game":"Test Game","Secs":600,"Front":500,"FpsN":0,"LowN":0,"Warns":0,"FpsSum":0,"LowSum":0,"Items":{},"Names":{}}')
Set-Content -Encoding ASCII "$d\test\data-h\hist.bin" 'not a history file'   # damaged: moved aside, not saved over
$p = Start-Deck 'data-h' 9232 300
Run 'release checks' test/e2e-hardening.mjs 9232 test/data-h
Quit-Deck $p 9232

New-Item -ItemType Directory "$d\test\data-bad" | Out-Null
Set-Content -Encoding UTF8 "$d\test\data-bad\state.json" '{"v":1,"L":{"cats":[{"id":"x"'
$p = Start-Deck 'data-bad' 9233 50
Run 'unreadable view' test/e2e-bad.mjs 9233 test/data-bad
Quit-Deck $p 9233

# a restart (--after) whose old copy still holds the data folder: the new copy waits for it instead of quitting
"== restart that has to wait"
if (Test-Path "$d\test\data-after") { Remove-Item -Recurse -Force -LiteralPath "$d\test\data-after" }
$p = Start-Deck 'data-after' 9233 50
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9234 $awake"
$q = Start-Process "$d\HWDeck.exe" -ArgumentList '--after', 999999, '--fake', 50, '--data', "$d\test\data-after" -WorkingDirectory $d -PassThru
Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
Start-Sleep -Seconds 3
$waited = -not $q.HasExited
Quit-Deck $p 9233
$up = $false
for ($i = 0; $i -lt 30 -and -not $up -and -not $q.HasExited; $i++) { Start-Sleep -Milliseconds 500; node -e "import('./test/cdp.mjs').then(m => m.connect(9234)).then(() => process.exit(0), () => process.exit(1))" 2>$null; $up = $LASTEXITCODE -eq 0 }
if ($waited -and $up) { "PASS the new copy waited for the old one, then started" } else { "FAIL the new copy (waited: $waited, started: $up)"; $failed++ }
if (-not $q.HasExited) { Quit-Deck $q 9234 }

# sleep and the end of a Windows session (port 9235): one cell always past its line. The test ends the session and
# this copy's WebView2 browser, so there is no page left to quit through
if (Test-Path "$d\test\data-p") { Remove-Item -Recurse -Force -LiteralPath "$d\test\data-p" }
New-Item -ItemType Directory "$d\test\data-p" | Out-Null
Set-Content -Encoding UTF8 "$d\test\data-p\state.json" '{"v":1,"L":{"v":1,"cats":[{"id":"ch","name":"Checks","collapsed":false,"cells":["hot"]}],"cells":{"hot":{"key":"f0000501.0/01000000","name":"Hot","graph":true,"gates":{"mode":"y","dir":"above","y":-1000,"hold":0}}}},"active":null,"edit":true,"screen":"tiles"}'
$p = Start-Deck 'data-p' 9235 300
Run 'sleep and session end' test/e2e-power.mjs 9235 test/data-p
if (-not $p.WaitForExit(3000)) { Stop-Process -Id $p.Id -Force }

# a history file another program holds while HW Deck starts: let go once it is up, then the app quits
if (Test-Path "$d\test\data-held") { Remove-Item -Recurse -Force -LiteralPath "$d\test\data-held" }
New-Item -ItemType Directory "$d\test\data-held" | Out-Null
Set-Content -Encoding ASCII "$d\test\data-held\hist.bin" 'held history'
$lock = [IO.File]::Open("$d\test\data-held\hist.bin", 'Open', 'Read', 'None')
$p = Start-Deck 'data-held' 9233 50
$lock.Close()
Run 'held history' test/e2e-held.mjs 9233 test/data-held
if (-not $p.WaitForExit(8000)) { Stop-Process -Id $p.Id -Force }   # the test quits it itself

# the bottleneck with a made-up game (port 9236): the test quits the app itself, to check the saved history
if (Test-Path "$d\test\data-bn") { Remove-Item -Recurse -Force -LiteralPath "$d\test\data-bn" }
$p = Start-Deck 'data-bn' 9236 300
Run 'bottleneck' test/e2e-bneck.mjs 9236 test/data-bn
if (-not $p.WaitForExit(8000)) { Stop-Process -Id $p.Id -Force }

# the game sessions popup and a made-up session's report (port 9237): a cell with lines on the CPU temperature, a fan
# cell that warns below
if (Test-Path "$d\test\data-g") { Remove-Item -Recurse -Force -LiteralPath "$d\test\data-g" }
New-Item -ItemType Directory "$d\test\data-g" | Out-Null
Set-Content -Encoding UTF8 "$d\test\data-g\state.json" '{"v":1,"L":{"v":1,"cats":[{"id":"ch","name":"Checks","collapsed":false,"cells":["hot","fan"]}],"cells":{"hot":{"key":"f0000501.0/01000000","name":"Hot CPU","graph":true,"gates":{"mode":"yr","dir":"above","y":60,"r":90,"hold":0}},"fan":{"key":"f0000501.0/03000002","name":"Fan check","graph":true,"gates":{"mode":"y","dir":"below","y":100,"hold":0}}}},"active":null,"edit":true,"screen":"tiles"}'
$p = Start-Deck 'data-g' 9237 300
Run 'game sessions' test/e2e-games.mjs 9237 test/data-g
Quit-Deck $p 9237

# layouts (port 9238): rows, columns and stacks, the looks, the handles, the drawers, the title bar; a fresh folder
if (Test-Path "$d\test\data-lay") { Remove-Item -Recurse -Force -LiteralPath "$d\test\data-lay" }
$p = Start-Deck 'data-lay' 9238 300
Run 'layouts' test/e2e-layout.mjs 9238 test/data-lay
Quit-Deck $p 9238

# tile looks (port 9239): every kind of tile in many layouts, measured for what looks broken; screenshots in test\out\gallery
if (Test-Path "$d\test\data-gal") { Remove-Item -Recurse -Force -LiteralPath "$d\test\data-gal" }
$p = Start-Deck 'data-gal' 9239 300
Run 'tile looks' test/gallery.mjs 9239 test/out/gallery
Quit-Deck $p 9239

# a window left open for a few minutes: timers and memory stay flat
if (Test-Path "$d\test\data-soak") { Remove-Item -Recurse -Force -LiteralPath "$d\test\data-soak" }
$p = Start-Deck 'data-soak' 9234 300
Run 'soak' test/soak.mjs 9234 150
Quit-Deck $p 9234

if ($failed) { "`n$failed run(s) with failures"; exit 1 } else { "`nevery run passed" }
