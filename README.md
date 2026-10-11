# HW Deck

A small dashboard for HWiNFO. Pick the sensors you care about, give them warning lines, and it keeps an eye on them, even from the tray.

![HW Deck](docs/screenshots/overview.png)

## Setup

1. Install [HWiNFO](https://www.hwinfo.com) and turn on Shared Memory Support in its settings.
2. Download `HWDeck-x.y.z.msi` from [Releases](https://github.com/RodrigoArsenioo/hwdeck/releases/latest) and run it. Or take the zip, unzip it anywhere and run `HWDeck.exe`.
3. The first time, Windows warns you because it isn't signed: click More info, then Run anyway.

Works on 64-bit Windows 10 and 11.

## Using it

- In edit mode (the pencil, or E), drag sensors from Storage (the tab on the left) into your view, or press + on one.
- Click a cell to see its graph, up to 7 days back.
- Select a cell to set yellow and red lines, or a curve on a fan. Select a category to set its width, height and look.
- Drop a category on the edge of another to put them side by side or stack them. Each view can be arranged its own way.
- Tiles, Overview and Grid are three ways to look at the same cells (keys 1, 2, 3).
- Closing the window keeps it in the tray, still watching. Right-click the tray icon to quit.
- The clock icon lists past warnings, the gamepad icon your game sessions.
- Bottleneck (under HW Deck in the list) says what limits your fps while a game runs: the GPU, the CPU, or an fps cap.

The free HWiNFO stops sharing after 12 hours. The arrow next to the views restarts it.

| | |
|---|---|
| ![Tiles](docs/screenshots/tiles.png) | ![Edit mode](docs/screenshots/edit.png) |
| ![Popup](docs/screenshots/popup.png) | ![Grid](docs/screenshots/grid.png) |

## Good to know

- No account, no tracking. The only thing it does online is ask GitHub once a day if there's a new version (you can turn that off in Settings).
- To update, run the new installer (or unzip the new zip over the old folder). Your layouts and history stay.
- To remove it: Windows Settings, Apps, HW Deck, Uninstall (for the zip, delete the folder). Your layouts and history stay.
- Your layouts and history are in `%APPDATA%\HW Deck`.
- Not made by or affiliated with HWiNFO.

## Building it

```
powershell -ExecutionPolicy Bypass -File scripts\fetch-deps.ps1
powershell -ExecutionPolicy Bypass -File scripts\build.ps1
```

More in [docs/DEVELOPING.md](docs/DEVELOPING.md). License: MIT.
