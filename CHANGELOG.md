# Changelog

## 1.4.7 (2026-10-15)

- Releases come as the installer only: the zip is gone. Install or update with the PowerShell line in the README, or run the installer.
- Game time, under HW Deck in Storage: how long the game you are playing has run (1h 05m), with its name under it. With no game it shows --.

## 1.4.6 (2026-10-15)

- Accurate game fps, in Settings (off by default). HWiNFO's fps can be another app's, a browser, Discord or a game's own launcher: HWiNFO reports whichever app makes the most frames. With this on, HW Deck counts the game's own frames, so sessions and the new Game framerate readings are right. Windows asks for permission once (it adds your account to Performance Log Users), then you sign out and back in. DirectX games; others keep HWiNFO's fps. Turning it off, or uninstalling, takes the permission back.

## 1.4.5 (2026-10-14)

- Dragging a cell no longer opens its settings (or, outside edit mode, its popup). A click still does.
- The new version check runs as soon as HW Deck starts, instead of 30 seconds later, or the next day when it had checked that day already.

## 1.4.4 (2026-10-14)

- The first-run screen, the red banner and the README say exactly where HWiNFO's sharing is switched on: Config, Main Settings, General / User Interface, Shared Memory Support.
- New in Settings: Keep HWiNFO sharing, off by default. A Windows task restarts HWiNFO (installed in Program Files) after about 11 hours, with sharing on, so the free version never hits its 12-hour limit. Turning it off deletes the task, and so does uninstalling HW Deck or deleting its folder.

## 1.4.3 (2026-10-13)

- Graphs scale better. A far spike (a second at 1,700 fps) no longer squashes the line: it's cut at the top with its value next to it. Readings that can't go below zero start at 0. And a small change stays small: a temperature graph spans at least 10 degrees.
- Each cell can set how early it fades toward its lines ("Fade in" in its Lines, in its own unit, 0 for none). Past yellow it now fades toward red too.
- Full animations switch to Minimal while a game is in front, and back after, to leave the CPU to the game. "Calmer during games" in Settings turns it off.

## 1.4.2 (2026-10-13)

- Full animations use about a third less CPU: a graph only slides when the move is big enough to see.
- Reduced is gone. It moved everything 10 times a second and looked choppy. Full costs less now, and Minimal keeps everything still. If you had Reduced, you get Full.

## 1.4.1 (2026-10-13)

- Memory shows in GB, with how much of it is in use ("34% of 64 GB"). Its lines are typed in GB too.
- Hide a reading or a whole sensor from Storage with the eye on its row. The Hidden chip brings it back.
- Storage hides an integrated GPU next to a discrete one, and readings that have only ever been 0, like empty fan headers (not a GPU's fans or error counts). They're under Hidden too.
- Animations draw at most 30 frames a second (10 in Reduced), so HW Deck uses far less CPU and GPU while it's on screen. Fans out of sight stop turning.
- The sessions and warnings popups open faster with long logs and free their memory when they close.
- Fixed: a session kept running while the PC slept, so a forgotten one counted the night.
- Fixed: a reading hovering on its line logged OK and YELLOW over and over, and its cell kept going back to normal.
- Fixed: one uneven 12V-2x6 connector could log the same warning twice.
- Fixed: a layout exported from the demo couldn't be imported in the app, and the other way round.
- Fixed: maximized, the window covered an auto-hide taskbar so it couldn't come up.
- Fixed: Keep sessions only applied to the list the next day.
- Fixed: a damaged settings file could later cut sessions and warnings down to 30 days. Now it's kept aside and nothing is cut until you set the days again.
- Fixed: a power cut or a crash at the wrong moment could empty a log or lose the session in progress. Files are written safely now, and the PC going to sleep saves everything first.
- Fixed: a line that warns below (a pump too slow) showed the mildest value as the peak in the warning history.
- Fixed: a warning whose reading went away (a drive unplugged) stayed ongoing until HW Deck quit.
- Fixed: the timeline of a session over 16 hours had its times on top of each other.
- Smaller fixes: Customize no longer redraws the whole dashboard, restoring the window no longer rebuilds it, the cell popup's longer graphs no longer redraw every minute, and Restart HWiNFO checks its maker's exact name before running it as admin.

## 1.4.0 (2026-10-12)

- Try it in your browser at rodrigoarsenioo.github.io/hwdeck, with made-up readings.
- Game sessions have a new layout: a summary on top, a chart of the fps and what limited it, and your readings in three columns with their yellow and red lines.
- Customize what a session shows: add, rename, hide or reorder categories, and put any reading in them.
- Record sessions of your own with Start session, for a benchmark or a render. Several can run at once, even next to a game.
- Delete a single session.
- Choose in Settings how many days sessions and warnings are kept (30 by default).
- The bottleneck is grey instead of coloured, and it works with no game running too.
- Fan curves: no PREDICTED tag and no tolerance band. Points stay sorted, so two at the same temperature make a step.
- Fixed: a fast click outside a popup didn't close it.
- Fixed: a click on a cell right after the window opened could be lost.
- Fixed: maximizing hid a few pixels at the top of the window.
- Fixed: on start, the dashboard showed placeholders for a moment and then jumped.
- Fixed: Enter in the days fields cancelled the question it opened.

## 1.3.0 (2026-10-12)

- Tiles can be any size, from a quarter of a tile to two tiles each way. Drag a tile's corner (it snaps to quarter steps, to the edges of other tiles and to the bottom of the column beside it; hold Alt for any size), type the size in tiles or pixels, or use Ctrl+arrows.
- Quick sizes in a tile's settings: its width and its height in quarter steps, from 0.25 to 2 (1 by 0.75 is two clicks).
- A tile can start a new row: it and the tiles after it go under the ones before it, so a row can end early.
- Give all of a category's tiles one size at once, or press Fit the row to make its column end level with the one beside it.
- Small tiles show what fits: first the graph goes, then the caption, and the smallest show just the value.
- One tile high is the same in every category, even where the tiles hold less (no caption or graph).
- A tall tile at the bottom of a category is really two tiles tall now.
- Lines on both sides: a cell can warn above one value and below another, like a pump that runs too slow or too fast.
- In Grid, game readings (fps, frame times) show this game session's min, average and max instead of HWiNFO's own.
- GPUs that report their 12V-2x6 pins get a connector cell: each pin's current, with a warning when one pin carries too much.
- Edit mode no longer runs past the bottom of the window, and the view leaves the same room at the bottom as at the sides.
- The fans count in Overview includes predicted fans, and Yes/No readings no longer warm toward yellow.
- Game sessions: the fps chart is three times taller, with a scale, fps and 1% low as their own lines, and a read-out for the minute you point at. "Limited by" shows how each minute split between GPU bound, CPU bound and capped, so it matches the percentages, each in its own colour.
- The bottleneck's popup has the ranges the other readings have (1 hour to 7 days), kept across restarts.
- A fan tracked against a curve can stay quiet when it's off it: untick "Warn when it is off the curve" and it only says how far off it is.
- The automatic arrangement puts the categories in balanced columns, as many as the window has room for.
- In Overview, the light on the row under the pointer leaves room around its icon and text.

## 1.2.0 (2026-10-11)

- Arrange each view your own way: drop a category on the edge of another to put them side by side or stack them, or start from 2 columns, 3 columns or one per row. A view stays automatic until you change it.
- Column widths follow what each column holds, so columns end about together and tiles line up. Drag the line between two columns to set them yourself.
- Looks per category and view: tiles per row, short tiles, a hidden title, the reading shown first; in Overview a card, a small card, a list or a band.
- Tiles can be wide, tall or big, and a cell can have its own name in each view.
- Fill the window: when there's room left, tiles grow taller to use it. Spacing (tight, normal, roomy) changes every gap.
- Long Overview cards split into columns and Grid spreads a long category over both tables, so more fits on screen.
- Edit mode shows the view at its real size: Storage and the settings slide in from the edges.
- The title bar shows this PC's name (or a title you pick) and the time. Restart HWiNFO sits next to the views.
- The window always opens inside the screen, and switching views is quicker.
- Switching views fast no longer freezes the window for a few seconds.

## 1.1.0 (2026-10-11)

- An installer (HWDeck-1.1.0.msi): Start menu shortcut, an optional desktop shortcut and Start with Windows, a new version installs over the old one, repair and uninstall from Windows settings. The zip stays for a copy you keep in a folder.
- Bottleneck: a new cell (under HW Deck in the list) that says what limits your fps while a game runs: the GPU, the CPU, or an fps cap.
- Game sessions got a new look: a table with fps, 1% low and what limited the game, and per session the main readings against their lines plus fps minute by minute.
- Tells you when a new version is out. It asks GitHub once a day; you can turn that off in Settings.
- Warnings cut short by quitting, sleep or HWiNFO stopping now keep their real peak.
- Going to sleep ends open warnings instead of counting the sleep as part of them.
- A frozen HWiNFO feed can't set off warnings anymore.
- A locked or damaged history file is kept aside instead of being overwritten.
- Fixes around shutdown, logoff and restarting; the window remembers it was maximized.
- Small UI fixes: search bar spacing, "Yellow + Red", single graph points show up.

## 1.0.0 (2026-10-11)

First release.
