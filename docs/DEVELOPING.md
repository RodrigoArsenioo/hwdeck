# Developing

## How it fits together

- `src/app.cs` is the whole Windows app (C#, .NET Framework 4, WinForms). It reads HWiNFO's shared memory, keeps the history, writes the logs and hosts the page.
- `web/` is the UI: plain HTML, CSS and JS in a WebView2 window. No framework, no build step.
- The two talk through WebView2 messages. The page can't reach the network.

## Build and run

```
powershell -ExecutionPolicy Bypass -File scripts\fetch-deps.ps1   # once, gets the WebView2 SDK
powershell -ExecutionPolicy Bypass -File scripts\build.ps1
.\HWDeck.exe
```

No Visual Studio needed, the build uses the C# compiler that comes with Windows. `scripts\pack.ps1` makes the release zip in `dist\`.

Flags: `-min` starts in the tray, `--data <dir>` uses another data folder, `--fake` makes up sensors for testing.

## Tests

```
powershell -ExecutionPolicy Bypass -File test\run-all.ps1
```

Needs Node 22 or newer and a built `HWDeck.exe`. About 100 checks on made-up data, in their own folders, so a running HW Deck isn't touched. Takes around 10 minutes and opens a few windows.

## Releasing

1. Bump the version in `src/app.cs` (`Version` and the two `Assembly...Version` lines).
2. Add a section at the top of `CHANGELOG.md`.
3. Push a tag like `v1.0.1`. GitHub Actions builds the zip and publishes the release.
