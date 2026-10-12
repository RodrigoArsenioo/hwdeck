# builds the browser demo into dist\demo (or the folder given): the page from web\ as it is, with demo\demo.js (the
# stand-in for the app) loaded just before deck.js; the Pages workflow builds the same thing
#   scripts\build-demo.ps1 [out folder]
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$out = if ($args.Count -gt 0) { $args[0] } else { "$dir\dist\demo" }
New-Item -ItemType Directory -Force $out | Out-Null
Copy-Item "$dir\web\deck.js", "$dir\web\deck.css", "$dir\demo\demo.js" $out -Force
$html = [IO.File]::ReadAllText("$dir\web\index.html")
$tag = '<script src="deck.js"></script>'
if (-not $html.Contains($tag)) { throw 'web\index.html has no deck.js script tag' }
$html = $html.Replace($tag, '<script src="demo.js"></script>' + "`n" + $tag)
$html = $html.Replace('<title>HW Deck</title>', '<title>HW Deck demo</title>' + "`n" + '<meta name="description" content="Try HW Deck, a small dashboard for HWiNFO, in your browser with made-up readings.">')
[IO.File]::WriteAllText("$out\index.html", $html, (New-Object Text.UTF8Encoding $false))
"built: $out"
