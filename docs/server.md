# Household server

The household server is a headless host of the same Rust core as the desktop
app (`crates/backend`). It serves the built frontend and the HTTP application
interface, owns first-administrator setup and household accounts, and is the
meeting point for synchronization between installed apps. It needs no companion
program and no AI process. One instance has one household.

## Run it

```sh
docker compose up -d --build   # with FORKCAST_DOMAIN=forkcast.example.com
```

The compose file builds the image (`Dockerfile`), keeps the SQLite database in
the `forkcast-data` volume, and puts Caddy in front for automatic HTTPS. Open
`https://<your domain>/` in a browser: an empty instance offers **Set up your
household** (household name, administrator username and password). The
administrator then creates the other household accounts under Settings.

Without Docker:

```sh
npm run build
cargo build --release -p forkcast-backend
FORKCAST_STATIC_DIR=dist FORKCAST_DATABASE=/var/lib/forkcast/forkcast.sqlite3 \
FORKCAST_BIND=127.0.0.1:8787 target/release/forkcast-backend
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `FORKCAST_BIND` | `127.0.0.1:8787` | Address to listen on. |
| `FORKCAST_DATABASE` | `forkcast.sqlite3` | SQLite file. Back it up like any database (stop the server or copy with the `.backup` command). |
| `FORKCAST_STATIC_DIR` | unset | A built frontend to serve at `/`. Unset serves the API only. |
| `FORKCAST_ALLOWED_ORIGINS` | the Vite dev origins | Extra browser origins allowed to call the API cross-origin. Not needed when the frontend is served by the server itself. |

## HTTPS and reverse proxies

The server speaks plain HTTP and expects TLS to end at a reverse proxy.
`deploy/Caddyfile` (used by the compose file) and `deploy/nginx.conf.example`
are complete examples. Both disable response buffering for `/api/changes`, the
server-sent event stream that tells clients to reload. Installed apps accept
`https://` servers, or `http://` on the same machine; a LAN deployment should
still use HTTPS (a private certificate authority or a name with a public
certificate).

## Upgrades

Replace the image or binary and restart. The server upgrades its database
through the shared, versioned migrations and adopts databases created before
versions existed in place, keeping accounts, sessions, recipes, retained
nutrition, conflicts, and pending history. A database from a newer release is
refused untouched.

## Release compatibility

Installed apps and the server declare a synchronization protocol version
(`X-Forkcast-Protocol`, also in `/api/status`). A mismatch makes the app show
that it cannot synchronize and keep every pending change; the server answers
`426` to a client declaring another version. Browsers served by the server are
always compatible with it.

## Security notes

- Passwords are hashed with Argon2; sessions are random 256-bit bearer tokens
  stored hashed, valid for 30 days, and revoked by sign-out, password reset, or
  disabling the account. Repeated failed sign-ins are throttled per username.
- Household and personal ownership is enforced by the core on every operation,
  independently of the frontend. Administrators manage accounts only; they get
  no access to other people's ratings, food logs, cooking sessions, or AI
  settings.
- ChatGPT/AI credentials are not handled by the server in this release; see
  the product specification for the integrated flow.
