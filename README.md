# Forkcast

A local-first recipe collection. Create, view, and edit recipes without an account,
application backend, or AI connection. The interface is English with metric defaults.

## Run locally

Install Node.js 20.19+ or 22.12+ and a current stable Rust toolchain, then:

```sh
rustup target add wasm32-unknown-unknown
npm ci
npm run dev
```

Open the local URL printed by Vite. `wasm-pack` is installed as a project development
dependency; the first build also downloads the matching `wasm-bindgen` tool.

For a production build:

```sh
npm run build
npm run preview
```

Deploy `dist/` to a static host over HTTPS (or serve it on localhost). There is no
application server to configure. Hash URLs let recipe links reopen on static hosts
without route rewrites. Keep the same origin to retain access to this device's data.

## Data and offline use

Recipes are stored in this browser's IndexedDB. Each recipe, ingredient, and cooking
step has a stable identity. Saving an edit updates that recipe after the database
transaction completes. Active time means dedicated work or attention; total time
means elapsed preparation time until the dish is ready. Difficulty and times may be
left unspecified.

The production build caches the application and WebAssembly assets using a service
worker. After the first online visit and cache installation, it can reopen offline.
The development server does not install an offline cache. Manual recipe actions do
not contact external services.

Browser data belongs to the browser profile and origin. Clearing site data removes
the collection; private browsing may discard it when the session ends. Cross-device
synchronization and backups require the future optional backend.

## Development and verification

```sh
npx playwright install chromium
npm run wasm:build
npm run typecheck
npm run check:rust
npm test
```

The Playwright suite builds and serves the production application, including the
actual Rust/WebAssembly module and offline cache. It exercises visible workflows
with real IndexedDB in isolated browser contexts at desktop and tablet sizes. No
backend, provider credentials, or network-service fixtures are needed for this slice.
To run one workflow:

```sh
npm test -- tests/recipes.spec.ts --project=desktop --grep "create a recipe"
```

`npm run typecheck` checks application, build configuration, and browser tests. Run
`npm run wasm:build` first after cloning or modifying the Rust export interface.
Rust changes need a new WebAssembly build; restart `npm run dev` or build it again.

## Layout

- `src/`: React screens, typed WebAssembly boundary, and local recipe storage.
- `crates/recipe-domain/`: Rust recipe types, normalization, and validation, also
  usable by a future native Rust backend. Generated WebAssembly is not committed.
- `tests/`: browser workflow specifications, the confirmed main testing seam.
- `docs/adr/` and `GLOSSARY.md`: accepted decisions and domain vocabulary.

This increment implements [issue #2](https://github.com/n-sim/forkcast/issues/2).
Planning, guided cooking, nutrition, AI, and backend synchronization are later work.
