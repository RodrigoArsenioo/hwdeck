# Runs every check on made-up data: the end-to-end test, a clean restart, the restart test, the scale test, the
# release checks (a prepared data folder), an unreadable working view, a restart that has to wait, sleep and the
# end of a Windows session, a held history file, the 12V-2x6 connector, the bottleneck with a made-up game, the game sessions popup and report,
# a build with extras, the layouts, tile sizes, lines on both sides, a game session's numbers, the tile looks, and a window
# left open for a few minutes. Uses its own data folders under test\ and debug ports 9230-9240, off the main screen; the real
# HW Deck (if running) is left alone.
#   powershell -File test\run-all.ps1
$d = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $d
# below normal priority, and so is every copy it starts: a game or work on this PC comes first
(Get-Process -Id $PID).PriorityClass = 'BelowNormal'
$failed = 0
# test windows sit behind other windows: keep Chromium from treating a covered window as hidden (it would slow its
# timers and stop its frames)
$awake = '--disable-features=CalculateNativeWinOcclusion --disable-renderer-backgrounding --disable-background-timer-throttling'
Add-Type -Namespace HWDeckTest -Name Win -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);'
Add-Type -AssemblyName System.Windows.Forms
$scr = [System.Windows.Forms.Screen]::AllScreens | Where-Object { -not $_.Primary } | Select-Object -First 1
if (-not $scr) { $scr = [System.Windows.Forms.Screen]::PrimaryScreen }
$wa = $scr.WorkingArea
# it opens on the screen under the mouse: move it to a screen other than the main one when there is one (same size,
# no focus) and behind every other window, so it doesn't cover anything. Leave the test windows alone while they run: a
# minimized or tray window gets no data and its checks fail
function Move-Behind($p) {
  for ($i = 0; $i -lt 20 -and $p.MainWindowHandle -eq 0; $i++) { Start-Sleep -Milliseconds 250; $p.Refresh() }
  if ($p.MainWindowHandle -ne 0) { [void][HWDeckTest.Win]::SetWindowPos($p.MainWindowHandle, [IntPtr]1, $wa.X + 40, $wa.Y + 40, 0, 0, 0x11) }
}
function Start-Deck([string]$data, [int]$port, [int]$fake, [string]$exe = "$d\HWDeck.exe") {
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$port $awake"
  $p = Start-Process $exe -ArgumentList '--fake', $fake, '--data', "$d\test\$data" -WorkingDirectory $d -PassThru
  Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
  Move-Behind $p
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
# and a damaged settings.json, with a session and a warning 40 days old next to recent ones
function Old-Logs([string]$dir) {
  $t = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds(); $o = $t - 40 * 86400; $n = $t - 3600; $ic = [Globalization.CultureInfo]::InvariantCulture
  $line = { param($g, $s) '{"game":"' + $g + '","start":' + $s + ',"end":' + ($s + 600) + ',"from":' + $s + ',"secs":600,"front":600,"items":[],"warns":0}' }
  Set-Content -Encoding ASCII "$dir\games.log" ((& $line 'Old Game' $o), (& $line 'New Game' $n))
  Set-Content -Encoding ASCII "$dir\alerts.log" (((Get-Date).AddDays(-40).ToString('yyyy-MM-dd HH:mm:ss', $ic) + '  YELLOW  Old: 1'), ((Get-Date).AddHours(-1).ToString('yyyy-MM-dd HH:mm:ss', $ic) + '  YELLOW  New: 1'))
}
Set-Content -Encoding ASCII "$d\test\data-bad\settings.json" '{"gameDays":'
Old-Logs "$d\test\data-bad"
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
if ($up) { Move-Behind $q }
if (-not $q.HasExited) { Quit-Deck $q 9234 }

# sleep and the end of a Windows session (port 9235): one cell always past its line. The test ends the session and
# this copy's WebView2 browser, so there is no page left to quit through
if (Test-Path "$d\test\data-p") { Remove-Item -Recurse -Force -LiteralPath "$d\test\data-p" }
New-Item -ItemType Directory "$d\test\data-p" | Out-Null
Set-Content -Encoding UTF8 "$d\test\data-p\state.json" '{"v":1,"L":{"v":1,"cats":[{"id":"ch","name":"Checks","collapsed":false,"cells":["hot"]}],"cells":{"hot":{"key":"f0000501.0/01000000","name":"Hot","graph":true,"gates":{"mode":"y","dir":"above","y":-1000,"hold":0}}}},"active":null,"edit":true,"screen":"tiles"}'
$p = Start-Deck 'data-p' 9235 300
Run 'sleep and session end' test/e2e-power.mjs 9235 test/data-p
if (-not $p.WaitForExit(3000)) { Stop-Process -Id $p.Id -Force }

# a history file and a settings file another program holds while HW Deck starts: let go once it is up, then the app
# quits
if (Test-Path "$d\test\data-held") { Remove-Item -Recurse -Force -LiteralPath "$d\test\data-held" }
New-Item -ItemType Directory "$d\test\data-held" | Out-Null
Set-Content -Encoding ASCII "$d\test\data-held\hist.bin" 'held history'
Set-Content -Encoding ASCII "$d\test\data-held\settings.json" '{"gameDays":365,"warnDays":365,"updates":false}'
Old-Logs "$d\test\data-held"
$lock = [IO.File]::Open("$d\test\data-held\hist.bin", 'Open', 'Read', 'None')
$lock2 = [IO.File]::Open("$d\test\data-held\settings.json", 'Open', 'Read', 'None')
$p = Start-Deck 'data-held' 9233 50
$lock.Close(); $lock2.Close()
Run 'held history' test/e2e-held.mjs 9233 test/data-held
if (-not $p.WaitForExit(8000)) { Stop-Process -Id $p.Id -Force }   # the test quits it itself

# the 12V-2x6 connector on made-up pins (port 9233 again, HWDECK_FAKEPINS)
if (Test-Path "$d\test\data-12v") { Remove-Item -Recurse -Force -LiteralPath "$d\test\data-12v" }
$env:HWDECK_FAKEPINS = '1'
$p = Start-Deck 'data-12v' 9233 300
Remove-Item Env:HWDECK_FAKEPINS
Run '12V-2x6 connector' test/e2e-12v.mjs 9233 test/data-12v
Quit-Deck $p 9233

# the bottleneck with a made-up game (port 9236): the test quits the app itself, to check the saved history
if (Test-Path "$d\test\data-bn") { Remove-Item -Recurse -Force -LiteralPath "$d\test\data-bn" }
$p = Start-Deck 'data-bn' 9236 300
Run 'bottleneck' test/e2e-bneck.mjs 9236 test/data-bn
if (-not $p.WaitForExit(8000)) { Stop-Process -Id $p.Id -Force }

# a build with extras (port 9236 again): test\ext\extras-test.cs compiled in, test\ext\extras.js next to the page, in
# test\out\ext; the test quits it itself, to check its stop hook
$x = "$d\test\out\ext"
if (Test-Path $x) { Remove-Item -Recurse -Force -LiteralPath $x }
New-Item -ItemType Directory "$x\web" | Out-Null
Copy-Item "$d\web\*" "$x\web\"; Copy-Item "$d\test\ext\extras.js" "$x\web\"; Copy-Item "$d\*.dll" $x
$null = powershell -NoProfile -ExecutionPolicy Bypass -File "$d\scripts\build.ps1" "$x\HWDeck.exe" "$d\test\ext\extras-test.cs"
if (Test-Path "$d\test\data-ext") { Remove-Item -Recurse -Force -LiteralPath "$d\test\data-ext" }
$p = Start-Deck 'data-ext' 9236 300 "$x\HWDeck.exe"
Run 'extras' test/e2e-ext.mjs 9236 test/data-ext
if (-not $p.WaitForExit(8000)) { Stop-Process -Id $p.Id -Force }

# the game sessions popup and a made-up session's report (port 9237): a cell with lines on the CPU temperature, a fan
# cell that warns below
if (Test-Path "$d\test\data-g") { Remove-Item -Recurse -Force -LiteralPath "$d\test\data-g" }
New-Item -ItemType Directory "$d\test\data-g" | Out-Null
Set-Content -Encoding UTF8 "$d\test\data-g\state.json" '{"v":1,"L":{"v":1,"cats":[{"id":"ch","name":"Checks","collapsed":false,"cells":["hot","fan"]}],"cells":{"hot":{"key":"f0000501.0/01000000","name":"Hot CPU","graph":true,"gates":{"mode":"yr","dir":"above","y":60,"r":90,"hold":0}},"fan":{"key":"f0000501.0/03000002","name":"Fan check","graph":true,"gates":{"mode":"y","dir":"below","y":100,"hold":0}}}},"active":null,"edit":true,"screen":"tiles"}'
$p = Start-Deck 'data-g' 9237 300
Run 'game sessions' test/e2e-games.mjs 9237 test/data-g
Quit-Deck $p 9237

# after 1.4.0 (port 9240): memory in GB, hidden from Storage, the popups, Customize, the re-measure, imports, a hovering warning
if (Test-Path "$d\test\data-14x") { Remove-Item -Recurse -Force -LiteralPath "$d\test\data-14x" }
$env:HWDECK_FAKEZERO = '1'   # (fans at 0 rpm all along: one hidden by default, one not)
$p = Start-Deck 'data-14x' 9240 300
Remove-Item Env:HWDECK_FAKEZERO
Run 'after 1.4.0' test/e2e-14x.mjs 9240 test/data-14x
Quit-Deck $p 9240

# layouts (port 9238): rows, columns and stacks, the looks, the handles, the drawers, the title bar; a fresh folder
if (Test-Path "$d\test\data-lay") { Remove-Item -Recurse -Force -LiteralPath "$d\test\data-lay" }
$p = Start-Deck 'data-lay' 9238 300
Run 'layouts' test/e2e-layout.mjs 9238 test/data-lay
Quit-Deck $p 9238

# tile sizes, lines on both sides, a game session's own numbers (port 9238 again, a fresh copy each)
foreach ($t in @(@('tile sizes', 'test/e2e-sizes.mjs', 'data-sz'), @('lines on both sides', 'test/e2e-lines2.mjs', 'data-l2'), @('game session numbers', 'test/e2e-gamestats.mjs', 'data-gs'))) {
  if (Test-Path "$d\test\$($t[2])") { Remove-Item -Recurse -Force -LiteralPath "$d\test\$($t[2])" }
  $p = Start-Deck $t[2] 9238 300
  Run $t[0] $t[1] 9238 "test/$($t[2])"
  Quit-Deck $p 9238
}

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

# the browser demo (built into dist\demo, served on port 8767 and opened in a headless Edge)
powershell -NoProfile -ExecutionPolicy Bypass -File "$d\scripts\build-demo.ps1" | Out-Null
Run 'browser demo' test/e2e-demo.mjs 0 ''

if ($failed) { "`n$failed run(s) with failures"; exit 1 } else { "`nevery run passed" }
