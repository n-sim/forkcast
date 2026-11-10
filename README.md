# Forkcast

A household recipe collection with meal planning, shopping lists, guided cooking, and a personal
food log. It works offline without an account, a server, or AI.

- **Installed app**: Windows desktop (supported) and Android (pre-release). The React frontend and
  the Rust application core run on the device with their own SQLite database.
- **Household server** (optional): hosts the same core so a household can share recipes, the meal
  plan, and the shopping list. Installed apps keep working offline and synchronize when the server
  is reachable. A browser can use the server directly as an online-only client.
- **ChatGPT** (optional): connect your own subscription in **Settings → ChatGPT** to generate
  recipes and plans and estimate nutrition and conversions.

See [the product specification](https://github.com/n-sim/forkcast/issues/1) and
[ADR 0015](docs/adr/0015-embed-a-shared-rust-core-and-synchronize.md) for the architecture.

## Install

Every merge to `main` is published as a
[release](https://github.com/n-sim/forkcast/releases) with the Windows installer, the Android APK,
the server binary, and the server image `ghcr.io/n-sim/forkcast`.

| Topic                                               | Guide                                            |
| --------------------------------------------------- | ------------------------------------------------ |
| Desktop app: building, data location, signing       | [docs/desktop.md](docs/desktop.md)               |
| Household server: Docker, Proxmox VE, HTTPS, backup | [docs/server.md](docs/server.md)                 |
| Android: building and release gates                 | [docs/android.md](docs/android.md)               |
| Core operations, errors, and change notifications   | [docs/core-interface.md](docs/core-interface.md) |

## Develop

Requires Node.js 20.19+ or 22.12+ and a stable Rust toolchain (with the MSVC build tools on
Windows).

```sh
rustup target add wasm32-unknown-unknown
npm ci
npm run desktop:dev      # app window with a Vite dev server
```

To try the browser client against a local server:

```sh
npm run build
FORKCAST_STATIC_DIR=dist npm run backend:dev    # then open http://127.0.0.1:8787
```

## Test

```sh
npm run test:prepare      # build the frontend, desktop app, and server
npm test                  # Playwright journeys: desktop, tablet, browser
cargo test --workspace    # core, sync engine, and server
npm run typecheck
npm run check:rust
npm run check:format
```

The Playwright suite drives the packaged desktop app (Windows, WebView2) and a real browser against
a real server. AI and Gurkerl journeys use local fixtures, so no external credentials are needed.
