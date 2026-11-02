# Developing

- `src/app.cs` is the Windows app (C#, WinForms): it reads HWiNFO, keeps the history and logs, and hosts the page.
- `web/` is the page: plain HTML, CSS and JS in WebView2. No framework, no build step.

## Build

```
powershell -ExecutionPolicy Bypass -File scripts\fetch-deps.ps1
powershell -ExecutionPolicy Bypass -File scripts\build.ps1
.\HWDeck.exe
```

No Visual Studio needed. `--fake` makes up sensors, `--data <dir>` uses another data folder.

## Test

```
powershell -ExecutionPolicy Bypass -File test\run-all.ps1
```

Needs Node 22 or newer. Takes about 30 minutes; its windows stay behind yours.

## Release

1. Bump the version in `src/app.cs` and `demo/demo.js`.
2. Add it to `CHANGELOG.md`.
3. Push the commit and its tag: `git push origin main v2.0.0`. GitHub builds and publishes it.
