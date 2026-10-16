# Changelog

## 1.5.1 (2026-10-16)

- Game sessions: the sessions popup shows the game you are playing at the top, "now playing", with its full report updating live. A session now ends 5 seconds after the game closes (was 30), and starting the same game again within 5 minutes carries on that session: the break shows in its chart and doesn't count as play, in its length, the week's numbers or Game time. The browser demo shows both.
- A view file another program holds, or one that can't be read: HW Deck no longer resets the view every few seconds while it waits. When it sets an unreadable view aside after 2 minutes, it saves the view you see right away, and files set aside together are named in one note. A save made just before a held view comes in no longer goes over it.
- Ending HW Deck from Task Manager while starting it again no longer leaves none running.
- After a second with no reading, a warning's hold starts again in the warning history too, as on its cell.
- Ctrl+arrows in a tile's size field keep the focus in the field. Moving a category right after Ctrl+arrows keeps the two steps in order for Undo.
- Customize's drag handles work on a touch screen.
- The sessions popup's week numbers count the same 7 days as its bars, and a session's chart puts its clock marks on round times in your own time zone.
- When Windows doesn't let your account count game frames, Accurate game fps says how to ask again.
- An update no longer turns Start with Windows back on because another copy of HW Deck has it on.
- A fan curve point dragged near the top of its chart no longer runs away to huge speeds.
- Maximized, the window's edges no longer show resize arrows or swallow a click: the top edge drags the window like the title bar.
- A 12V-2x6 connector cell with its lines set to None still puts uneven pins in the warning history, as its tile shows them.
- Smaller fixes: a slot another program held at the start comes in once it is free, even while the view is still held, and a file that can be read again is never set aside as damaged; Grid's cells can be dragged on a touch screen in edit mode; a Customize drag whose list changed under it no longer drops the row at the end; a cell removed and brought back starts its warning fresh, as the warning history does; the 12V-2x6 connector's pin warning follows the warning history while its pin readings are gone; a reading added in the middle of a second no longer ends or starts a warning a second early; a tile let go where it was is marked selected; a second finger on a touch screen no longer takes over a drag, a size handle, a fan curve point or a Customize row; a cell added or re-linked lets a selected category go, so a second Delete doesn't remove the category; warnings keep counting while you drag, and for cells you can't see, and a line half typed no longer turns a cell yellow; the settings drawer stays open while you drag a fan curve point, and Escape puts the point back; turning a cell's lines off ends its warning on the page too, as in the warning history; a cell's colour is judged once a second with that second's values, as the warning history does, so a redraw, a game coming to the front or a cell brought back with Undo no longer shows a warning the history never had; Escape on a curve point leaves Undo and Redo as they were; the browser demo fills in the minutes a background tab missed; a name being typed in Customize stays when the readings list changes; Keep HWiNFO sharing counts HWiNFO's hours right across a clock change (turn it off and on once to update its task); a click on a cell or a category right after typing a size or a name selects it; a cell drawn first in its category, dragged further down it, lands where the mark showed; a game coming to the front no longer redraws the view under a cell or handle you are holding; pressing E while holding a cell lets go of it instead of moving it after edit mode is off; clicking the "Bad when above" or "below" already picked no longer moves a cell's lines past its reading (it stopped warning); clicking "All fit", "Fill the window" or the table count already picked changes nothing; Escape on a cell you are holding lets go of it without selecting it; the drop mark in a category with a cell shown first marks where the cell really lands.

## 1.5.0 (2026-10-16)

- Keep HWiNFO sharing: HWiNFO comes back by itself after the task restarts it. Its welcome screen used to wait for a click, sharing nothing. The task now turns that screen off and starts HWiNFO in Sensors-only mode.
- Keep HWiNFO sharing says under its switch when the task couldn't do its job (HWiNFO moved out of Program Files, no admin rights, a signature that didn't check out).
- Game framerate shows nothing instead of 0 for games HW Deck can't count (Vulkan, OpenGL, DirectX 9) and for the first seconds after you switch back to a game. Their sessions keep HWiNFO's fps.
- Alt-tabbing out of a game no longer shows its background frame cap as its fps for a few seconds, or logs fps warnings for it.
- Update now (from this version on) says how it went once HW Deck is back: updated, cancelled, or why it didn't install. It reopens the same copy, and never installs an older version.
- Lines on a Game time cell turn it yellow and red, like any cell.
- Start with Windows shows off when Task Manager has HW Deck turned off at startup. Turning it on in HW Deck, or a new install with it ticked, turns it back on there too.
- Apps that run in the background all day from Steam (Bongo Cat, VTube Studio, OBS, Blender and the like) no longer count as a game: a session starts only with a game in front. Neither do launchers, browsers and media apps added to Steam (Battle.net, EA app, GOG Galaxy, Playnite, Chrome), nor Windows' own programs when one of them is added to Steam (cmd, PowerShell, the on-screen keyboard): Task Manager or Calculator in front no longer starts a session that lasts all day. Games added to Steam through one emulator go by the emulator's name, not by the first game's.
- A reading hovering on its line no longer flashes its cell back to white and replays the glow every second. Past its line, waiting out its hold time, a cell keeps its amber edge instead of going plain.
- A game that closes no longer has the half minute after it counted as play: a game that ran under a minute isn't listed, a session's averages leave out the idle PC after the game, and Game time stops when the game does.
- The installer keeps what you tick or untick for Start with Windows and the desktop shortcut, on a new install and on an upgrade.
- Graphs of readings that sit at or near 0 most of the time (a drive's rate, a fan stopped at idle) show their bursts again instead of cutting them off.
- Smaller fixes: Game time no longer counts a sleep for a second after the PC wakes; the demo has Game time; two Windows accounts on one PC no longer stop each other's Accurate game fps or take over each other's Keep task; the Keep task (it runs as admin) keeps its script where only admins can write and starts clean of the user's settings that could load code into it; starting HW Deck while a copy runs as admin no longer crashes; a failed export says so; a window shown from the tray comes back on a screen that's still there; Settings no longer loses what you're typing when it updates; a failed update deletes its download, and an antivirus checking the new installer no longer stops it; a view file another program had open as HW Deck started (a sync tool, an antivirus) is no longer set aside as damaged, and if it's still held when the page starts, HW Deck says so, saves nothing over it and shows it once it's free (a slot held the same way says so when you save to it); the window's place and the log lines are written safely; HW Deck stops reopening its page after it closed three times in a few minutes, and says so; a session picked up again after a restart no longer counts its first part twice; a quick look at another game right after a switch no longer moves the session again; Automatic Grid shows one table or two by which gives the bigger text, the same every time for a window (it used to depend on the view before it, and could flip on a resize); a days value typed in Settings is kept when Settings redraws; the toast's Undo no longer undoes a newer change; the warning history shows peaks below 0; searching "GB" finds memory readings; the browser demo no longer opens calmed, and its Game time has no made-up min and max; quitting while HWiNFO wasn't sharing (or with no game running) no longer puts an old value in the graphs; ticking a box in a cell's settings takes one undo step, not two; moving a category with Alt+arrows stays one undo step in a long session; Customize in the sessions popup puts a name back when you clear it, and doesn't mark the layout changed when nothing changed; Grid's Tables Two and Three give that many tables, also when the last category is the big one; Ctrl+S takes a name or size you're still typing, and a tile resize you just made with Ctrl+arrows; after saving into another slot, Undo no longer links the view back to the slot you left; importing into a filled slot asks first, and Undo can't make the view that slot again; Show older in the warning history keeps open groups open; a cell with lines and a fan curve logs the right peak; after its page's browser stops, a minimized HW Deck comes back in the tray instead of open; uninstalling also removes Start with Windows when it was turned on in Settings. HW Deck no longer grabs the focus for a moment when it starts in the tray, or when a monitor's scale changes behind a game (a TV turned on). Accurate game fps turned off and on again before signing out still works after the next sign-in; Restart HWiNFO finds a portable HWiNFO in a folder with an apostrophe in its name; a 1 px Ctrl+arrow step on a big tile is kept, and so is the other side when you change one; a wide tile in a one-per-row category stays wide when you make it wider; a cell turns yellow or red in the same second as its warning in the log; in the browser demo, a reading added from Storage has its last 15 minutes at once. The 12V-2x6 connector's pin warning stays on while a pin hovers around 1.5x its share, as in the log; one unreadable Steam or Epic game file no longer hides the games listed after it; a recording's name cleared and left comes back; after emptying a slot, Undo can't make the view that slot again. Ending HW Deck from Task Manager after closing it to the tray once quits it cleanly instead of hiding it; a view or slot file that stays unreadable (a bad sector, permissions from another install) is set aside after 2 minutes instead of blocking every save; saving into a slot another program has open (a sync or a backup tool) waits for it instead of picking another slot or linking the view to it; dragging a row in Customize keeps a name you were typing; a cell's warning follows the log around a HWiNFO stall; a GOG DLC no longer renames its game, and Steam rewriting its library list no longer drops games for 10 minutes; edit mode sizes the text with hidden titles as the normal view does; unticking Start with Windows in the installer also removes one turned on in Settings, and uninstalling removes it from a folder with an apostrophe too.

## 1.4.8 (2026-10-15)

- Update now: when a new version is out, the button in Settings downloads it, checks it, installs it and opens HW Deck again (Windows asks for permission once). It used to open the releases page. Works from this version on, for HW Deck installed with the installer.

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
