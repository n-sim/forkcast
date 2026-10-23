# Forkcast desktop app

The desktop app is the React frontend and the Rust application core in one
installation (`crates/desktop`, built with Tauri 2). Recipes, planning,
shopping lists and PDFs, resumable cooking, and the food log work without a
server, an account, a companion program, a terminal, or a backend URL. Data is
stored by the embedded core in SQLite and survives restarts and upgrades.

## Supported and tested platforms

| Platform | Status |
| --- | --- |
| Windows 10 and 11 (x64), WebView2 runtime 120 or newer | **Supported and tested.** Build, install, restart, upgrade, import, retry, failure, keyboard focus, and file delivery are exercised against the packaged app by `npm test`. |
| macOS, Linux | Not supported yet. The code is portable, but credential protection falls back to memory (sign in again after a restart) and nothing has been run there. |
| Android | See [android.md](android.md). Not released. |

WebView2 ships with Windows 11 and current Windows 10. The installer
bootstraps it if it is missing.

## Where things live

| What | Where |
| --- | --- |
| Application data (SQLite, WAL files) | `%APPDATA%\app.forkcast.desktop\forkcast.sqlite3` |
| Session tokens for a household server | `secrets.dat` beside it, encrypted with Windows DPAPI for the signed-in Windows user |
| Web content cache | `%LOCALAPPDATA%\app.forkcast.desktop\EBWebView` |

`FORKCAST_DATA_DIR` overrides the data folder (used by automation and for a
second profile). The app never reads or writes browser storage; the web view
holds only presentation state.

If the data folder cannot be opened (read-only disk, a database from a newer
Forkcast, damage) the window shows the reason with **Try again** and **Open
data folder**. Nothing is reset or deleted automatically.

## Keyboard shortcuts

Press **?** (or choose **Keyboard shortcuts** in the sidebar) for the list.
Number keys **1**–**5** open the recipe collection, meal plan, food log,
shopping list, and settings; **N**/**G** start a new or generated recipe, **P**
plans cooking, **M**/**R** add a manual or recipe food-log entry, and **←**/**→**
move between weeks in the meal plan and between steps while cooking (finishing
cooking always takes a deliberate click). **Esc** leaves a new, generated, or
edited recipe without saving, asking first when you have entered something, and
cancels the open form in the meal plan and the food log. Shortcuts are single
unmodified keys: apart from **Esc** they never fire while you type in a field,
none fire while a dialog is open, and keys
with Ctrl, Alt, or the Windows key stay with Windows and the web view. Each
shortcut presses a visible button or link, so everything stays usable with a
pointer or touch, and the same shortcuts work in the browser.

## Build and install

Prerequisites: Node.js 20.19+ or 22.12+, a current stable Rust toolchain with
the `wasm32-unknown-unknown` target, and on Windows the MSVC build tools.

```sh
npm ci
npm run desktop:build      # frontend, core, and the NSIS installer
```

The installer is written to
`target/release/bundle/nsis/Forkcast_<version>_x64-setup.exe`. It installs per
user (no administrator rights), adds a Start-menu entry, and an upgrade
installs over the previous version keeping all data. For development:

```sh
npm run desktop:dev        # Vite dev server plus the app window
```

## Upgrades

Updates follow application releases: install the new installer over the old
one. The core upgrades its database through the shared, versioned migrations
(`user_version`). A database written by a newer Forkcast is refused with a
visible message and left untouched; an upgrade that cannot complete is rolled
back. Web assets are bundled and there is no service worker, so an update
cannot be replaced by a stale cache.

## Signing and distribution

No keys, certificates, or tokens are committed or required to build. For a
public release you need:

- **Windows code signing**: an Authenticode certificate (OV or EV). Set
  `bundle.windows.certificateThumbprint` (or use `signCommand`) in a release
  configuration passed with `npx tauri build --config release.json`, keeping
  the certificate in your CI secret store. Unsigned installers work but show
  SmartScreen warnings.
- **Updates**: ship new installers through your normal channel; the app has no
  self-updater.
- **macOS/Linux** (when supported): an Apple Developer ID plus notarization;
  distribution packages for your Linux targets.

## Automated acceptance

`npm test` drives the packaged app, not a viewport in a browser:

1. `npm run test:prepare` builds the frontend, the app (`custom-protocol`, so
   assets are embedded as in a release), and the server.
2. The suite launches `target/debug/forkcast-desktop.exe` with an isolated
   data folder and WebView2 profile, attaches to its window over the DevTools
   protocol, and exercises real SQLite through the real native bridge.
3. A restart is a real process restart on the same data folder; an upgrade
   with data is exercised by importing a populated transfer and reopening.
4. Synchronization journeys start two app processes and a real server.
   `FORKCAST_SAVE_DIRECTORY` makes the app deliver saved files (the shopping
   PDF) to a folder instead of opening a save dialog.

Keyboard focus is covered by the layout and form journeys (tab order, skip
link, dialog focus).
