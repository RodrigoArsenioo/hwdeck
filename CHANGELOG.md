# Changelog

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
