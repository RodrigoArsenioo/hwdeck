# HW Deck

A small dashboard for HWiNFO. Pick the sensors you care about, give them warning lines, and it keeps an eye on them, even from the tray.

**[Try it in your browser](https://rodrigoarsenioo.github.io/hwdeck/)** with made-up readings, nothing to install.

![HW Deck](docs/screenshots/overview.png)

## Setup

1. Install [HWiNFO](https://www.hwinfo.com) and switch on its shared memory, once:
   - Start HWiNFO with **Sensors-only** ticked.
   - In the sensors window, click **Config**, then **Main Settings**.
   - On the **General / User Interface** tab, tick **Shared Memory Support**, then OK.

   The free HWiNFO stops sharing after 12 hours. HW Deck's restart button (the arrow next to the views) turns it back on. Or turn on Keep HWiNFO sharing in Settings, and HW Deck restarts it for you before then.
2. Paste this into PowerShell. It downloads the newest installer from [Releases](https://github.com/RodrigoArsenioo/hwdeck/releases/latest), checks it against its published checksum and runs it ([the script](install.ps1)):

   ```
   irm https://raw.githubusercontent.com/RodrigoArsenioo/hwdeck/main/install.ps1 | iex
   ```

   Or download `HWDeck-x.y.z.msi` from Releases and run it, or take the zip, unzip it anywhere and run `HWDeck.exe`. Downloaded with a browser, Windows warns the first time because it isn't signed: click More info, then Run anyway.

Works on 64-bit Windows 10 and 11.

## Using it

- In edit mode (the pencil, or E), drag sensors from Storage (the tab on the left) into your view, or press + on one. The eye on a row hides it from Storage; the Hidden chip brings it back.
- Click a cell to see its graph, up to 7 days back.
- Select a cell to set yellow and red lines (above, below, or both), or a curve on a fan. Select a category to set its width, height and look.
- In Tiles, drag a tile's corner to make it any size (hold Alt for exact pixels), or type the size in its settings.
- Drop a category on the edge of another to put them side by side or stack them. Each view can be arranged its own way.
- Tiles, Overview and Grid are three ways to look at the same cells (keys 1, 2, 3).
- Closing the window keeps it in the tray, still watching. Right-click the tray icon to quit.
- The clock icon lists past warnings, the gamepad icon your sessions: games, and ones you record yourself.
- Bottleneck (under HW Deck in the list) says what limits your fps: the GPU, the CPU, or an fps cap. It works without a game too.

## Good to know

- No account, no tracking. The only thing it does online is ask GitHub if there's a new version (when it starts, then once a day) (you can turn that off in Settings).
- To update, run the new installer. For the zip, quit HW Deck from the tray first, then unzip the new one over the old folder. Your layouts and history stay.
- To remove it: Windows Settings, Apps, HW Deck, Uninstall (for the zip, delete the folder). Your layouts and history stay.
- Your layouts and history are in `%APPDATA%\HW Deck`.
- Not made by or affiliated with HWiNFO.

## Building it

```
powershell -ExecutionPolicy Bypass -File scripts\fetch-deps.ps1
powershell -ExecutionPolicy Bypass -File scripts\build.ps1
```

More in [docs/DEVELOPING.md](docs/DEVELOPING.md). License: MIT.
