#!/usr/bin/env bash
# Installs or upgrades the Forkcast household server on Debian 12 or newer.
#
# The Proxmox VE script (deploy/proxmox/forkcast.sh) runs this inside the new
# container and keeps it there as `forkcast-update`. It also works on its own
# on any Debian machine, virtual machine, or container with systemd:
#
#   curl -fsSL https://raw.githubusercontent.com/n-sim/forkcast/main/deploy/proxmox/forkcast-install.sh | sudo bash
#
# Settings (environment variables):
#   FORKCAST_VERSION  release to install, for example 0.0.9 (default: the latest release)
#   FORKCAST_DOMAIN   public name for automatic HTTPS through Caddy. Unset, the server
#                     serves HTTPS itself on port 8787 with its own certificate, which
#                     installed apps confirm by its fingerprint (forkcast-fingerprint
#                     prints it). Kept from the previous run when unset.
#
# Running it again upgrades to the latest release: the server is stopped, the
# database is copied to /var/lib/forkcast/backups, the new release replaces
# /opt/forkcast, and the server restarts and migrates the database itself.

set -Eeuo pipefail

REPO="n-sim/forkcast"
APP_DIR="/opt/forkcast"
DATA_DIR="/var/lib/forkcast"
CONFIG_DIR="/etc/forkcast"
ENV_FILE="$CONFIG_DIR/forkcast.env"
SERVICE="forkcast"

msg_info() { printf ' \e[33m…\e[0m %s\n' "$*"; }
msg_ok() { printf ' \e[32m✔\e[0m %s\n' "$*"; }
msg_error() { printf ' \e[31m✘\e[0m %s\n' "$*" >&2; }
trap 'msg_error "Failed at line $LINENO: $BASH_COMMAND"' ERR

[[ $EUID -eq 0 ]] || { msg_error "Run this as root."; exit 1; }
[[ $(uname -m) == x86_64 ]] || { msg_error "Forkcast server releases are built for x86-64 only."; exit 1; }
command -v systemctl >/dev/null || { msg_error "systemd is required."; exit 1; }

# The domain chosen at first install stays unless a new one is given.
if [[ -z ${FORKCAST_DOMAIN:-} && -f $CONFIG_DIR/domain ]]; then
  FORKCAST_DOMAIN=$(<"$CONFIG_DIR/domain")
fi
FORKCAST_DOMAIN=${FORKCAST_DOMAIN:-}

msg_info "Installing dependencies"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl jq sqlite3 >/dev/null
if [[ -n $FORKCAST_DOMAIN ]]; then
  apt-get install -y -qq --no-install-recommends caddy >/dev/null
fi
msg_ok "Installed dependencies"

msg_info "Looking up the release"
if [[ -n ${FORKCAST_VERSION:-} ]]; then
  release_url="https://api.github.com/repos/$REPO/releases/tags/v${FORKCAST_VERSION#v}"
else
  release_url="https://api.github.com/repos/$REPO/releases/latest"
fi
release=$(curl -fsSL -H "Accept: application/vnd.github+json" "$release_url")
version=$(jq -r '.tag_name | ltrimstr("v")' <<<"$release")
asset=$(jq -c --arg name "forkcast-server-$version-linux-x64.tar.gz" \
  '.assets[] | select(.name == $name)' <<<"$release")
[[ -n $asset ]] || { msg_error "Release $version has no Linux server package."; exit 1; }
download=$(jq -r '.browser_download_url' <<<"$asset")
digest=$(jq -r '.digest // "" | ltrimstr("sha256:")' <<<"$asset")
installed=$(cat "$APP_DIR/VERSION" 2>/dev/null || true)
msg_ok "Release $version${installed:+ (installed: $installed)}"

if ! id forkcast &>/dev/null; then
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin forkcast
fi
install -d -o forkcast -g forkcast -m 0750 "$DATA_DIR"
install -d -m 0755 "$CONFIG_DIR"

if [[ $installed != "$version" ]]; then
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT

  msg_info "Downloading Forkcast $version"
  curl -fsSL -o "$work/server.tar.gz" "$download"
  if [[ -n $digest ]]; then
    echo "$digest  $work/server.tar.gz" | sha256sum -c --quiet -
  fi
  tar -xzf "$work/server.tar.gz" -C "$work"
  msg_ok "Downloaded Forkcast $version"

  if systemctl is-active --quiet "$SERVICE"; then
    msg_info "Stopping the server"
    systemctl stop "$SERVICE"
    msg_ok "Stopped the server"
  fi

  if [[ -f $DATA_DIR/forkcast.sqlite3 ]]; then
    msg_info "Backing up the database"
    backup="$DATA_DIR/backups/$(date +%Y%m%d-%H%M%S)-${installed:-unknown}"
    install -d -o forkcast -g forkcast -m 0700 "$DATA_DIR/backups" "$backup"
    sqlite3 "$DATA_DIR/forkcast.sqlite3" ".backup '$backup/forkcast.sqlite3'"
    # The server's own certificate goes with it, so joined apps keep trusting it.
    for file in "$DATA_DIR"/forkcast.tls.crt "$DATA_DIR"/forkcast.tls.key; do
      if [[ -f $file ]]; then cp -p "$file" "$backup/"; fi
    done
    chown forkcast:forkcast "$backup"/*
    msg_ok "Backed up the database to $backup"
  fi

  msg_info "Installing Forkcast $version"
  rm -rf "$APP_DIR.new"
  mv "$work/forkcast-server-$version-linux-x64" "$APP_DIR.new"
  echo "$version" >"$APP_DIR.new/VERSION"
  chown -R root:root "$APP_DIR.new"
  chmod -R u=rwX,go=rX "$APP_DIR.new"
  rm -rf "$APP_DIR.old"
  if [[ -d $APP_DIR ]]; then mv "$APP_DIR" "$APP_DIR.old"; fi
  mv "$APP_DIR.new" "$APP_DIR"
  rm -rf "$APP_DIR.old"
  msg_ok "Installed Forkcast $version"
fi

msg_info "Configuring the service"
if [[ -n $FORKCAST_DOMAIN ]]; then
  bind="127.0.0.1:8787"
  echo "$FORKCAST_DOMAIN" >"$CONFIG_DIR/domain"
else
  bind="0.0.0.0:8787"
  rm -f "$CONFIG_DIR/domain"
fi
# Without a domain the server serves HTTPS with its own certificate. Releases
# from before that existed know nothing of FORKCAST_TLS and serve plain HTTP.
tls="off"
if [[ -z $FORKCAST_DOMAIN ]] && grep -q FORKCAST_TLS "$APP_DIR/forkcast-backend"; then
  tls="self-signed"
fi
cat >"$ENV_FILE" <<EOF
# Forkcast household server settings; see docs/server.md.
# Restart after changes: systemctl restart $SERVICE
FORKCAST_BIND=$bind
FORKCAST_DATABASE=$DATA_DIR/forkcast.sqlite3
FORKCAST_STATIC_DIR=$APP_DIR/web
FORKCAST_TLS=$tls
EOF

cat >/usr/local/bin/forkcast-fingerprint <<EOF
#!/bin/sh
# Prints the SHA-256 fingerprint of the Forkcast server's own certificate.
set -a
. $ENV_FILE
if [ "\$FORKCAST_TLS" != self-signed ]; then
  echo "This server does not serve HTTPS with its own certificate." >&2
  exit 1
fi
exec $APP_DIR/forkcast-backend --fingerprint
EOF
chmod 0755 /usr/local/bin/forkcast-fingerprint

cat >/etc/systemd/system/$SERVICE.service <<EOF
[Unit]
Description=Forkcast household server
Documentation=https://github.com/$REPO/blob/main/docs/server.md
After=network-online.target
Wants=network-online.target

[Service]
User=forkcast
Group=forkcast
EnvironmentFile=$ENV_FILE
ExecStart=$APP_DIR/forkcast-backend
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF

if [[ -n $FORKCAST_DOMAIN ]]; then
  cat >/etc/caddy/Caddyfile <<EOF
# Forkcast household server with automatic HTTPS (written by forkcast-install).
$FORKCAST_DOMAIN {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8787 {
		# The change stream is long-lived; never buffer it.
		flush_interval -1
	}
}
EOF
  systemctl enable --quiet caddy
  systemctl restart caddy
fi

systemctl daemon-reload
systemctl enable --quiet "$SERVICE"
systemctl restart "$SERVICE"
msg_ok "Configured the service"

msg_info "Waiting for the server to answer"
for _ in $(seq 1 30); do
  # shellcheck source=/dev/null
  if (set -a && . "$ENV_FILE" && "$APP_DIR/forkcast-backend" --health) &>/dev/null; then
    msg_ok "Forkcast $version is running"
    if [[ $tls == self-signed ]]; then
      msg_ok "Certificate fingerprint (SHA-256): $(/usr/local/bin/forkcast-fingerprint)"
    elif [[ -z $FORKCAST_DOMAIN ]]; then
      msg_info "Release $version serves plain HTTP; installed apps need a later release or a reverse proxy."
    fi
    exit 0
  fi
  sleep 1
done
msg_error "The server did not answer. See: journalctl -u $SERVICE"
exit 1
