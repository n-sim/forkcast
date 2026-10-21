# Household server

The household server is a headless host of the same Rust core as the desktop
app (`crates/backend`). It serves the built frontend and the HTTP application
interface, owns first-administrator setup and household accounts, and is the
meeting point for synchronization between installed apps. It runs AI
for its members itself, using the ChatGPT sessions they hand over from the installed app over
HTTPS (see `FORKCAST_SECRETS_FILE`); it needs no companion program, SSH setup, or separate AI
process. One instance has one household.

## Run it

```sh
docker compose up -d --build   # with FORKCAST_DOMAIN=forkcast.example.com
```

The compose file builds the image (`Dockerfile`), keeps the SQLite database in
the `forkcast-data` volume, and puts Caddy in front for automatic HTTPS. Open
`https://<your domain>/` in a browser: an empty instance offers **Set up your
household** (household name, administrator username and password). The
administrator then creates the other household accounts under Settings.

On Proxmox VE, one command on the host creates an unprivileged Debian
container with the latest release as a systemd service:

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/n-sim/forkcast/main/deploy/proxmox/forkcast.sh)"
```

It shows its defaults (1 core, 512 MiB, 4 GiB, DHCP on `vmbr0`) and asks
before creating anything; **Advanced** changes them, and the variables at the
top of [`deploy/proxmox/forkcast.sh`](../deploy/proxmox/forkcast.sh) set them
without questions (`FORKCAST_YES=1`). Without further setup the server serves
HTTPS itself on port 8787 with its own certificate, and the script ends by
printing the address and the certificate's fingerprint for installed apps to
confirm (see below). With a public name (`FORKCAST_DOMAIN`) that points at the
container, Caddy gets a publicly trusted certificate for it instead. The
database and certificate are in `/var/lib/forkcast`, the settings in
`/etc/forkcast/forkcast.env`, and `pct exec <CTID> -- forkcast-fingerprint`
shows the fingerprint again.
`pct exec <CTID> -- forkcast-update` upgrades to the latest release, keeping a
copy of the database in `/var/lib/forkcast/backups` first. The installer
inside the container, [`deploy/proxmox/forkcast-install.sh`](../deploy/proxmox/forkcast-install.sh),
works the same way on any Debian 12 or newer machine with systemd.

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
| `FORKCAST_SECRETS_FILE` | the database path with a `.secrets` extension | Owner-only file (`0600`) holding members' ChatGPT sessions. Keep it with the data volume but out of database backups you share; it is what lets the server run AI for its accounts. Members set it up from the installed app (**Settings → ChatGPT**); no SSH or token copying is needed. |
| `FORKCAST_TLS` | unset | `self-signed` serves HTTPS with the server's own certificate, created on first start beside the database (`forkcast.tls.crt` and the owner-only `forkcast.tls.key`). Unset or `off` serves plain HTTP for a reverse proxy. |
| `FORKCAST_TLS_CERT`, `FORKCAST_TLS_KEY` | unset | PEM certificate chain and private key to serve HTTPS with (for example a certificate from your own CA or ACME client). With `FORKCAST_TLS=self-signed` they name where the self-signed pair is kept instead. |
| `FORKCAST_STATIC_DIR` | unset | A built frontend to serve at `/`. Unset serves the API only. |
| `FORKCAST_ALLOWED_ORIGINS` | the Vite dev origins | Extra browser origins allowed to call the API cross-origin. Not needed when the frontend is served by the server itself. |

## Browsers

A browser is an online client of this server: open its address, sign in with
a household account, and every read and write goes to the server's core over
`/api/operations`. Nothing needs to be installed on the browser's device. The
browser keeps only its sign-in token; it has no database, no queue of unsent
changes, and no service worker, and every response is sent `Cache-Control:
no-store`. When the server cannot be reached the browser says so and saves
nothing, and an expired or revoked sign-in returns to the sign-in page. The
installed app is the offline mode.

A browser uses the account's ChatGPT connection on the server once it has
been set up. Connecting and reconnecting happen in the installed app
(**Settings → ChatGPT**), which the browser's Settings explains.

If the current frontend is opened from an address without a household server
(for example a leftover static deployment of the retired browser-only
version), it says so and points to the installed app and the household
server; it never opens, changes, or deletes data stored in that browser.

## HTTPS

Installed apps accept `https://` servers, or `http://` on the same machine.
Passwords, session tokens, and members' ChatGPT sessions travel over this
connection, so plain `http://` LAN addresses are refused. There are two ways
to serve HTTPS.

**The server's own certificate**, for a home network without a domain name or
reverse proxy. Set `FORKCAST_TLS=self-signed`: on first start the server
creates a certificate beside its database, keeps it across restarts and
upgrades, and prints its SHA-256 fingerprint:

```text
Certificate SHA-256 fingerprint: 45:9C:29:25:…:D3:B1:F3:F5
Forkcast backend listening on https://0.0.0.0:8787
```

`forkcast-backend --fingerprint` (with the same settings) prints it again.
When an installed app connects to `https://<address>:8787`, Settings shows the
fingerprint the server presented; compare it with the one above and confirm.
The app then accepts only that certificate from this server, whatever its
address, name, or expiry date, and refuses to send anything to a server that
presents another one. Browsers show a certificate warning for the address
once; accept it after checking the same fingerprint in the browser's
certificate details.

If the certificate files are lost or replaced (for example when only the
database is restored onto a new server), joined apps stop synchronizing and
say the server presented a different certificate; their changes stay on the
device. **Check the server's certificate** in Settings then shows the new
fingerprint to confirm, and synchronization resumes. Back up
`forkcast.tls.crt` and `forkcast.tls.key` with the database to avoid this,
and keep them as private as the database.

**A reverse proxy with a publicly trusted certificate**, for a server with a
public name. `deploy/Caddyfile` (used by the compose file) and
`deploy/nginx.conf.example` are complete examples. Both disable response
buffering for `/api/changes`, the server-sent event stream that tells clients
to reload. Installed apps check such certificates against the public
certificate authorities they ship with; authorities installed on the device
are not consulted. A certificate from your own authority can instead be served
by the server itself with `FORKCAST_TLS_CERT` and `FORKCAST_TLS_KEY`, and apps
confirm its fingerprint as above.

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
- Members' ChatGPT sessions live only in `FORKCAST_SECRETS_FILE`, keyed by
  account. They are never returned to browsers or apps, never part of
  synchronization, and never in the database.
