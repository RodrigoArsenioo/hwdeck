HW Deck
=======

A small dashboard for HWiNFO.

Setup
1. Install HWiNFO (hwinfo.com) and turn on Shared Memory Support in its settings.
2. Start HW Deck from the Start menu.

Good to know
- Closing the window keeps it in the tray. Right-click the tray icon to quit.
- The free HWiNFO stops sharing after 12 hours. HW Deck then offers to restart it. Keep HWiNFO sharing in Settings does that for you before it stops.
- It asks GitHub if there's a new version when it starts, then once a day (Settings can turn that off). Nothing else goes online.
- To update: paste this into PowerShell again, or run the new installer from the releases page:
  irm https://raw.githubusercontent.com/RodrigoArsenioo/hwdeck/main/install.ps1 | iex
- Your data is in %APPDATA%\HW Deck. To remove the app: Windows Settings, Apps, HW Deck, Uninstall (your data stays).

Updates: https://github.com/RodrigoArsenioo/hwdeck
License: MIT (LICENSE). WebView2 SDK license: THIRD-PARTY-NOTICES.txt.
