# Runs every check on made-up data: the end-to-end test, a clean restart, the restart test, the scale test, the
# release checks (a prepared data folder), an unreadable working view, and a window left open for a few minutes.
# Uses its own data folders under test\ and debug ports 9230-9234; the real HW Deck (if running) is left alone.
#   powershell -File test\run-all.ps1
$d = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $d
$failed = 0
function Start-Deck([string]$data, [int]$port, [int]$fake) {
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$port"
  $p = Start-Process "$d\HWDeck.exe" -ArgumentList '--fake', $fake, '--data', "$d\test\$data" -WorkingDirectory $d -PassThru
  Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
  Start-Sleep -Seconds 5
  return $p
}
function Quit-Deck($p, [int]$port) {
  # a clean quit through the page, so history and logs get written; killed if it hangs
  node -e "import('./test/cdp.mjs').then(async m => { const p = await m.connect($port); p.evaluate('send({ t: \'exit\' })').catch(() => {}); setTimeout(() => process.exit(0), 500); })" | Out-Null
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
$p = Start-Deck 'data-h' 9232 300
Run 'release checks' test/e2e-hardening.mjs 9232 test/data-h
Quit-Deck $p 9232

New-Item -ItemType Directory "$d\test\data-bad" | Out-Null
Set-Content -Encoding UTF8 "$d\test\data-bad\state.json" '{"v":1,"L":{"cats":[{"id":"x"'
$p = Start-Deck 'data-bad' 9233 50
Run 'unreadable view' test/e2e-bad.mjs 9233 test/data-bad
Quit-Deck $p 9233

# a window left open for a few minutes: timers and memory stay flat
if (Test-Path "$d\test\data-soak") { Remove-Item -Recurse -Force -LiteralPath "$d\test\data-soak" }
$p = Start-Deck 'data-soak' 9234 300
Run 'soak' test/soak.mjs 9234 150
Quit-Deck $p 9234

if ($failed) { "`n$failed run(s) with failures"; exit 1 } else { "`nevery run passed" }
