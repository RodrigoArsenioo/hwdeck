# Changelog

## 2.4.2 (unreleased)

- Tile graphs move again with Animations on Full: since 2.1.0 a tile's graph stopped taking in new readings in Full.
- Warnings:
  - A game in the background (alt-tab) no longer logs a false "back to normal" for its fps lines, and coming back no longer counts the same warning twice.
  - A fan that should be stopped by its curve but spins now counts as off its curve.
  - A cell's warning keeps its own name in the log when a build's own line for the same reading steps aside.
  - Starter names the 12V-2x6 cell "12V-2x6", so its pins' warnings read "12V-2x6 pins".
- Saves and slots:
  - A slot file that can't be read is set aside and said, instead of showing as empty and being saved over.
  - A slot the app couldn't write no longer reads as saved.
  - Clicking another button in Saves while renaming a slot now does both.
  - Clearing an already empty view adds no undo step.
- History and game sessions:
  - After a crash, the 7 day graphs keep the whole block the app was in, not the part before the restart.
  - A game that restarts within the same minute keeps that whole minute in its timeline.
  - A short game that ended while Sessions was closed no longer comes back as "now playing".
  - Start session numbers its session after all of yours, not only the game picked.
- The cell popup:
  - A late answer for a range you already left no longer blanks the graph or draws it in twice.
  - A "bad when below" line close under the data shows on the graph.
  - The last game session reads grey in the popup and in the hover preview, with its own numbers.
- Editing:
  - Making an Automatic view your own no longer moves categories past the sixth in a column to the bottom.
  - With no cells left outside edit mode, the view shows its empty state, not a blank window.
  - Ctrl+arrows and Line up the bottom keep a tile's own width when only its height changes.
  - A wiggle on a column line no longer freezes a row that follows its content.
  - Alt+arrows: the lead cell keeps its place, quick presses no longer swap back, and a burst on another category is its own undo step.
  - The fan curve table keeps its rows in place while you Tab between its fields.
  - Flipping "Bad when" swaps the lines of both sides, so none quietly stops warning.
  - A drag scrolled with the wheel drops where the pointer is.
- Speed: the app does less while hidden or minimized, retries a busy games.log less often, keeps its bins from being rewritten every day, turns the game frame counter off while no game is in front, and lays out the view fewer times on a start, a resize and a scroll.
- Keyboard and screen readers: popups take the focus and give it back, the confirm reads its question, Escape steps back one layer at a time (a list, a pick, a chip) before closing a popup, buttons that show only an icon have names, and switches, chips, rows and folds say whether they are on or open.
- With HWiNFO off at the start, cells say HWiNFO isn't sharing instead of "not on this PC", and the view's settings work.
- The category name's hint shows only in edit mode.

## 2.4.1 (2026-11-06)

- The settings panel is redrawn, shorter and with one line of help at most:
  - Its title is the name of what you selected, and a back button goes from a cell to its category and from a category to the view's settings. The pin is gone: Selected in the editing bar keeps the panel open.
  - The view's settings: the outline right under Arrangement, marking the rows that fill; templates named 2 a row, 3 a row and 1 a row; Height is Fit or Fill; one line of counts at the bottom.
  - Grid: one Tables row, Auto, 1, 2 or 3, instead of Arrangement and Tables. It offers no more tables than categories, and changing the count keeps each category in its table.
  - A category: Column width as a % field and % chips, only the widths that fit its row; Its row, Fit or Fill; the four moves always shown, greyed out where they can't go, each with its key; Width of all and Height of all as chips with Auto, and Level to line up its column. Reset Tiles look also gives its tiles their own size back.
  - A cell: one Name field, for all views or only this one; Width and Height chips with Auto and 0.75; First and New row buttons (First replaces the category's Shown first in Tiles, New row is off on a category's first tile); Decimals, with Auto, and Graph as chips; Hold, fade and the other side folded under one line in Lines.
  - Remove from view is now Remove cell (it leaves every view), and the settings show its category after. Remove category and Remove cell show their key, Del.
  - The lists left in the settings (Big reading, Listed first, a fan curve's source) open a menu in the app's own look, like the game history's All Games, with the arrow keys, Enter and Escape.
  - The chips, the fold and the lists tell a screen reader what they are and whether they are on or open.
- The settings stay out while a cell or category is selected: they no longer slide away when the pointer leaves them or keeps working in the view. Esc, a click on empty space, Selected or the X put them away.
- Selected in the editing bar stays lit while something is selected, and switching it off also deselects the cell or category.
- Storage no longer has a pin button: the Storage button in the editing bar opens and closes it.
- A button in the editing bar you click to close its panel no longer looks selected while the pointer is still on it.
- Fill (was Fill the window) is a setting of the view: it no longer makes an automatic Tiles view your own, and Automatic keeps it. A row of yours can still fill on its own. With little room left, Fill no longer makes the view smaller than Fit: the text keeps the size Fit gives it.
- A tile you size yourself is drawn at exactly that width, even in a row that would otherwise spread out to fill the width. Its width in the settings is the width it is drawn at, the field and the chips always agree, a typed 33 or 67 is the third its chip gives, and changing only its height no longer pins its width.
- Undo and redo go back to the view where the change was made and select again what was selected.
- Delete or Backspace with the focus on a settings button no longer removes the selected category or cell.
- Ctrl+Z in a settings field undoes the last change when nothing is typed in it; Tab moves between the settings' fields.
- A Yes/No graph counts a minute with nothing recorded as No: in a popup its line drops to No there, and pointing at it reads No, also in a warning's chart (it showed a gap and --).
- A number in a colour (a warning, the last game session's grey) no longer flashes white when the view is drawn again, for example on a Height switch.

## 2.4.0 (2026-11-05)

- Themes: Settings > Look starts with eight themes to pick from: Classic, OLED, Soft, Warm, Slate, Aurora, Sunset and Neon. Classic is the look of earlier versions; OLED and Soft, before choices under Cards, are themes now.
- Background: a base colour and a soft fade from any edge or corner, each with its own colour, size and strength.
- Cells: their fill colour, how see-through they are, an outline or none, and sharp, normal or round corners.
- Spectrum has a new palette, Match, that takes its colours from the background's fades, so the two always go together.
- Popups, Settings and the side panels take the theme's colours.
- Your look carries over: Standard opens as Classic, OLED and Soft as their themes, with the colours you had.
- Settings no longer turns see-through while you pick a colour.

## 2.3.0 (2026-11-05)

- With Animations on Full, a popup opened by a click grows out of the tile or button you clicked.
- A popup opened over another one: the one underneath steps back, and the view behind is no longer darkened and blurred twice.
- With Animations on Minimal, layout edits slide into place too (a short slide, no fades).
- Moving the pointer from one tile to the next switches the hover preview at once, however slowly you cross the gap between them.
- The side panels slide at the same speed as popups, and colour changes share one timing.

## 2.2.0 (2026-11-05)

- A tile's size in Tiles is now a share of its row, shown as a %, and a height in rows. It stays the same at any window size and text size, and the size settings no longer show pixels or steps of quarters and thirds: a width in % with 25, 33, 50, 67, 75 and 100%, and a height in rows with 0.5, 1, 1.5 and 2. Dragging a tile's corner snaps to those widths, and Ctrl+arrows change the width by 1% (with Shift, to the next of those widths).
- Tiles per row is no longer a category setting. Layouts that used it look as they did: each tile's width becomes its share of the row.
- No tile is drawn narrower than a minimum that fits its name and caption. Where a window is too narrow for that, the tiles in those rows split evenly over fewer per row (four tiles of 25% become two and two) instead of cutting their text.
- A caption that doesn't fit uses shorter words wherever it appears (tiles, Overview rows and Grid), for example "max 51.0 W" or "not shared by HWiNFO". A name that doesn't fit gets slightly smaller text instead of being cut, and names you type are limited to 24 characters.
- A Grid caption a few pixels too long for its cell is now noticed as cut.

## 2.1.2 (2026-11-04)

- A "15 min max" caption that doesn't fit its tile says just "max", for example "max 1,049 RPM", instead of being cut. It is checked only when its text or the tile's size changes.
- HWDeck.exe carries its real version in its file details again (2.1.1's said 2.1.0).

## 2.1.1 (2026-11-04)

- With no game running, Game time has a graph too: the last 24 hours, Yes for each minute a game was on.
- Captions that were cut in a narrow tile fit now: the Bottleneck's last session (its two biggest shares, without "last:" in front), Game time's last session (when it ended) and the 1% low while a game runs (shorter words, the same numbers).

## 2.1.0 (2026-11-04)

- The bottleneck tells a cap far more often. HW Deck now gets the game's frames from Windows every quarter of a second instead of every second, and only the two Present events it uses. Before, the newest frames were often over a second old when it judged, so it couldn't tell, and kept its last answer. Measured with a test game on an RTX 5090: fps caps from 60 to 238 read capped 100% of the time (38 to 94% before), with no answers left unsure (up to 62% before). The cost is 0.15% of one CPU core, and the game's frame times didn't change.
- A capped game with one busy CPU thread reads capped once its fps has held for 30 seconds. Before, a thread at 80% always meant CPU bound.
- In a game whose frames HW Deck can't count (Vulkan, OpenGL, or Accurate game fps off), HWiNFO's fps sitting at the screen's refresh rate reads as capped (vsync). Its caption says only vsync caps can be seen there.
- The game cells say more: FPS its average this session, 1% low how far under the fps it sits and its lowest of 15 minutes, Bottleneck its split with the most first ("CPU 87%, GPU 10%, capped 3%").
- The bottleneck's description is rewritten in plain words.
- With no game running, the game cells show your last session in a softer grey: its average fps and 1% low with each minute as the graph, how long it lasted and when it ended, and what limited it with each minute as the strip. "last session" sits in each tile's corner, and Game time's corner says how long you played in the last 24 hours. Before, they showed "--" with nothing under it, and Bottleneck showed the desktop's "FPS capped" next to "no game running".
- The bottleneck is a graph now, like the other cells: a line that steps between GPU bound, CPU bound and capped, in its tile, row and table, with the three names along its side in the hover and the popup. A game session's details draw what limited it the same way.
- The dot for unsaved changes sits on the Save button now, not on Saves.
- Tiles: a row of normal-size tiles that leaves room at its end shares it out, so seven tiles four to a row read four over three, all the width. Tiles you sized yourself stay as you set them, and a category of a single row stays as it is.
- Tile sizes in thirds: 1/3, 2/3, 4/3 and 5/3 sit under the quarter steps, so three tiles of 4/3 fill a row of four.
- Calmer during games now also covers a session you start yourself: Full animations switch to Minimal while it records.
- When a game ends, the game cells wait a moment for its summary, so the session before it never flashes in between.
- Smoother motion:
  - A game coming to the front or leaving it no longer rebuilds the whole view: what moves settles in place.
  - A warning's glow is a layer that fades, so the tile isn't painted again every frame. While a game is in front it is shorter.
  - With a popup open, the view under it holds still.
  - A game cell switching between the game and its last session fades once, with no digits rolling from one number to the other.
  - Buttons fade their hover colours.
  - Tooltips show at once right after another one.
  - A new toast message bumps.
  - The HWiNFO banner comes in as one change.
  - The "now" marker under a cell's lines glides.
  - A graph's line turns yellow or red with its text.
  - The popup's hover guide moves at the same speed on any screen.
  - Off has no press scale or tile lift left, and Windows' reduce motion counts from the first frame.
  - Changing Animations or Calmer during games settles the view in place instead of rebuilding it, so the switch moves at once.
  - Back from the tray or the taskbar, the view shows where things are now at once, without rolling digits or sliding graphs from minutes before.
  - A tile you resize glides to its new size, as the tiles around it do.
  - The bottleneck's graph steps from one call to the next instead of sliding through the one between.
  - A button's dot fades in and out.
  - A popup that an extras build opens holds the view still too.
  - A session you record shows in Game sessions without a red wash, and its dot holds still.
- Lighter on the PC:
  - The game check every 3 seconds reads only the process ids, not every process and thread.
  - Game folders are looked for again hourly, or when a new program comes to the front, not every 10 minutes.
  - The history writes only what is new every 15 minutes, to hist.jrn, and writes hist.bin whole once a day and at exit. Before, it rewrote hist.bin every 15 minutes, about 18 MB an hour on a big layout. It keeps the same safety: after a crash, the journal comes back too.
  - Graphs are drawn again only when a pixel would change, and a past session's graph is drawn once.
  - The page lays itself out once a second instead of twice.
  - Back from the tray, only the missed seconds are sent.
  - pace.log stays open while a game is counted, and past 20 MB it becomes pace.log.old.
  - Where HWiNFO runs from is checked on its own process once a minute, not with a list of every process and thread.
  - The frame count's quarter-second timer sleeps while no game is in front, and counting a game's frames no longer makes new lists every second.
  - The popup's and the hover's graphs keep their size instead of measuring the page every second.
- Editing: the settings open on the other half of the window from what you click. With half or more of it on the left, they open on the right, and the other way round. Before, a cell on the right half moved them only if they would have covered it. Settings you pinned or moved yourself, or Storage open, still decide as before.
- Game sessions from before 2.0.1 have their bottleneck worked out again, once, the first time 2.1 starts. They called it "FPS capped" whenever the GPU was under 85% and no CPU thread was busy, and they didn't keep the pace of the frames that 2.0.1 goes by. They did keep each minute's average fps: minutes where it held at one value, or at a cap the same game showed in another session, stay capped, and the rest counts as CPU bound. A note says how many sessions changed, once. The log as it was stays beside it (games.log.before-2.1).
- The window keeps its size when you un-maximize it or bring it back from the taskbar. Before, it grew by the height of a title bar each time.

## 2.0.2 (2026-11-03)

- The bins: the delete button says "Delete permanently", in its hover text, the question it asks and the note after.
- Editing: the settings stay open when they slide across to the other side. They went away once past the pointer, as if it had been in them and left (after moving the selected category to the other side and clicking it again).

## 2.0.1 (2026-11-03)

- The bottleneck tells an fps cap from the CPU by the pace of the game's frames. "FPS capped" now needs the frames to come at a steady pace. With the GPU under 85% and the pace going up and down, it says CPU bound. Before, an uncapped game whose busiest CPU thread stayed under 80% read "FPS capped" most of the time. It needs Accurate game fps (Settings). Without it, or in a Vulkan or OpenGL game, it can't see a cap, so a capped game reads CPU bound.
- The bins: every row has a button to delete it permanently. It asks first, and there is no undo.

## 2.0.0 (2026-11-02)

- Look, in Settings: the cards (Standard, OLED: true black with the cards drawn as lines, Soft: no lines, a shadow) and the colour (Mono, Accent: one colour on the tabs, periods and switches, Spectrum: a colour for each category on its name, icons and graphs, and the accent). Nine palettes to start from, and any colour of your own for the accent or a category: a grid of tones, a hex, or the full picker. Spectrum's colours carry to the cell popup, the hover preview, game sessions and the warning history. While you pick, Settings turns see-through for a moment so you see the change on the view.
- Warning history, redone like game sessions: the last 7 days at a glance, a period and a cell to look at, a bar a day split yellow and red, each cell's share, and a row per cell and day that opens to each crossing and a chart of the reading around it.
- Bins for game sessions and warnings: Select picks rows (or Pick all) to move to the bin, and the bin icon shows what is in it, to bring back. What Keep sets aside goes there too. Undo takes a move back. Keep sessions and Keep warnings can be Forever, now the default.
- Starter: a first layout built from this PC's sensors for a new user. Someone with a layout of their own gets a note, and Starter stays in Saves to load.
- The title bar: Save beside Saves, undo and redo always there, and while editing a strip of its own (Category, Storage, Selected, undo, redo, Done). Storage and the cell settings can move to either side; pinned, they stay open.
- Game sessions: start one of your own with the play button (it asks first), with a recording strip to rename it and stop it. Sessions open shut, and the one you open scrolls to the middle.
- Every hover text is HW Deck's own tip. Tab no longer walks the buttons, and there are no focus rings.
- Folding a category is gone. Switches slide. The texts across the app were rewritten.
- Motion: Storage and the cell settings slide in from the side they open on, and across when they swap sides. Categories and cells glide to their new places after a move, an undo or a redo. Settings' choices slide, rows going to or from a bin slide, and the session you open glides to the middle. Minimal and Off turn it down as before.
- Narrow windows: editing keeps the window's own buttons on screen, and the session and warning rows keep their names.

## 1.5.11 (2026-10-31)

- The 12V-2x6 connector's pin bars, and the pins in its popup, turned yellow at 9.2 A and red at 9.5 A whatever lines you gave the cell. They now follow the cell's own lines, like the cell itself and the warning history.

## 1.5.10 (2026-10-27)

- The window keeps its size and place when that place is on a screen that isn't there as HW Deck starts (a TV that is off, a monitor unplugged). It opened at its default size, and the next save put that size over yours. It now opens at your size on the screen you're on, keeps your place, and goes back there once that screen is on again, unless you moved it in the meantime. The same goes for a screen that goes away while HW Deck runs.

## 1.5.9 (2026-10-26)

- The spinning fan icons in Overview's rows turned around a point just below their middle, so they wobbled. They now turn in place.

## 1.5.8 (2026-10-25)

- A restart of HWiNFO (Restart HWiNFO, or Keep HWiNFO sharing's task) no longer bothers you: HWiNFO comes back in the tray and its window never opens. It could come back as a window on the taskbar, or open, and take the focus. The restart now sets HWiNFO to start minimized, Sensors-only and without its welcome screen, with its close button minimizing to the tray. If HWiNFO takes the focus as it starts, it goes back to the window you were in. Keep HWiNFO sharing also waits until you haven't touched the keyboard or mouse for 2 minutes (until HWiNFO has run 11 h 40 min at most, as for a game). Turn it off and on once to update its task.

## 1.5.7 (2026-10-25)

- Keep HWiNFO sharing: a task turned on with 1.5.0 kept that version's script, which counted HWiNFO's run time in local time, so the night the clocks go back it could restart HWiNFO an hour late, after the free version's 12 hours. Settings now says to turn it off and on once, which updates it.

## 1.5.6 (2026-10-23)

- After a graphics driver update (or a driver reset) the window could stay slow, a few frames a second, until HW Deck was started again. It now starts itself again 30 seconds later, and waits while a game or another full-screen app is in front.

## 1.5.5 (2026-10-19)

- A click anywhere on the 12V-2x6 connector cell opens it, its pin bars too (they didn't).

## 1.5.4 (2026-10-18)

- Settings, Same game again: how long a game can be closed and still carry on its session when you start it again. 30 minutes unless you change it (it was a fixed 5); 0 makes every start a new session.
- Settings are grouped: Window, Startup, HWiNFO, Games, Data, Keys and About, each in its own block.

## 1.5.3 (2026-10-17)

- Yes/No readings (throttling flags and the like) show as Yes or No everywhere: their HWiNFO average as a share of Yes (it showed "0% yes" or "1% yes"), their lines in Grid, the popup and its graph, game session reports and the warning history (they showed "1 Yes/No"). Lines added to a Yes/No cell start where they warn on Yes (they started where a Yes/No reading never gets, so it never warned; such lines saved by an older version are moved there, without marking a saved slot as changed), and lines added to a usage (%) cell stay within 100%. Lines suggested for "bad when below" are never put under zero on a reading that doesn't go there (they are left for you to type), and Intel's Distance to TjMAX gets lines for when it gets low (it was offered the high-temperature ones, which never warn); a game session's "hottest" no longer picks it, renamed or not.
- A reading a hair below zero shows 0, not -0.
- A HWiNFO reading that turns infinite for a moment no longer stops every value on the page for the rest of a game session, and the session still gets its line (a session an older version saved with one too).
- The clock set back (a time sync) no longer cuts, splits or drops a game session or one of your own, and no longer stretches a warning's hold: they go on with the time they ran. Quitting right after still saves the history, and a minute's graph point isn't written over by the seconds lived again. A session HW Deck finds ahead of the clock when it starts is logged at its own times.
- Game session files: one that a backup or sync tool holds as HW Deck starts is read once it is free (HW Deck saves beside it meanwhile, in games.current.2.json or games.custom.2.json), so the session it kept isn't lost; a session is never logged twice, even when its file couldn't be deleted; a session line games.log refuses (another program holds it) is kept in games.log.pending until it goes in, so a quit or a crash meanwhile doesn't lose it (that file held too is read once free); a game closed just as Windows reuses its process id ends on time; a session written just before a power loss no longer takes the next session's line with it.
- settings.json held by another program as HW Deck starts is read again every 5 seconds, with what you changed meanwhile kept (the run used to stay on defaults: Accurate game fps and update checks off until a restart).
- Game session reports keep voltages and currents at their own decimals (they kept one), and colour a peak by the lines it really passed.
- Now playing stays at the top of the sessions popup when a merged session's earlier line couldn't be taken out of games.log at once (it is tried again), and the open popup updates when a line that had to wait goes in. Clear and Delete also take out what was waiting to go in for those sessions, and a session file read later doesn't bring them back.
- Smaller fixes: a click on a category's or cell's settings right after typing its name or a size there now does what it says (the typed value went in and the click was lost); Ctrl+arrows in a tile's size field apply the size typed there first, and typing right after Ctrl+arrows is no longer wiped; a list in the cell or category settings used with the keyboard keeps the focus (as do its buttons after Space or Enter), Ctrl+Z and Escape work there, and one opened with the mouse lets go once a key for the page comes (1 2 3, E, Delete); a double-click on a remove button (a category's x, Remove from view, Remove category, a curve point's x) or a reading's x in Customize, a Hide in Storage, or on a button or a backdrop that closes its popup (a slot's Load, a question's answer) does one thing, and its second press doesn't land on what was under it (the same for any button in a cell's or category's settings); with Animations off, the popup graph's hover line follows the pointer without gliding; a tap on the title bar or a window edge on a touch screen no longer leaves the window stuck to the pointer; the sessions popup opens any session from the keyboard (Enter or Space), and Customize picks the category whose name you reach with Tab.

## 1.5.2 (2026-10-16)

- A layout or setting that couldn't be saved because another program had the file open is saved again every few seconds until it goes in (it used to wait for your next change, and a quit lost it).
- The quick graph you see when you hover a Yes/No cell shows a short Yes as Yes, as its full graph does.
- Undo after Ctrl+arrows and a setting changed right away goes back through them in order.

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
