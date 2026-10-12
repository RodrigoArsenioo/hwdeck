# Developing

## How it fits together

- `src/app.cs` is the whole Windows app (C#, .NET Framework 4, WinForms). It reads HWiNFO's shared memory, keeps the history, writes the logs and hosts the page.
- `web/` is the UI: plain HTML, CSS and JS in a WebView2 window. No framework, no build step.
- The two talk through WebView2 messages. The page can't reach the network; the app's only network use is the daily version check (GitHub's latest release).

## Build and run

```
powershell -ExecutionPolicy Bypass -File scripts\fetch-deps.ps1   # once, gets the WebView2 SDK
powershell -ExecutionPolicy Bypass -File scripts\build.ps1
.\HWDeck.exe
```

No Visual Studio needed, the build uses the C# compiler that comes with Windows. `scripts\pack.ps1` makes the release zip and the installer in `dist\` (the installer needs the .NET SDK: WiX 5 comes from `.config\dotnet-tools.json`, the setup itself is `installer\HWDeck.wxs`).

Flags: `-min` starts in the tray, `--data <dir>` uses another data folder, `--fake` makes up sensors for testing (that copy never takes the focus; `HWDECK_NOFOCUS=1` does the same for a copy on real data).

## Tests

```
powershell -ExecutionPolicy Bypass -File test\run-all.ps1
```

Needs Node 22 or newer and a built `HWDeck.exe`. About 150 checks on made-up data, in their own folders, so a running HW Deck isn't touched. Takes around 10 minutes and opens a few windows.

## Releasing

1. Bump the version in `src/app.cs` (`Version` and the two `Assembly...Version` lines).
2. Add a section at the top of `CHANGELOG.md`.
3. Push a tag like `v1.1.1`. GitHub Actions builds the zip and the installer and publishes the release.
